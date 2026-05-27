// ---------------------------------------------------------------------------
// FloodGuard — adapter-level rate-limit + debounce + queue-depth cap for
// Telegram inbound. Keyed by raw telegram userId.
//
// Design invariants:
//   * In-memory state is bounded — periodic sweep evicts senders with no
//     batch, no in-flight turns, and no recent timestamps in the window.
//   * The only thing that outlives eviction is the abuse counter, which is
//     persisted to disk so an attacker can't reset it by going quiet.
//   * Per-turn AbortController. The signal is passed to the dispatch
//     callback (and onward to agent.chat). A janitor scans in-flight entries
//     every 60s and calls abort() on anything past its deadline.
//   * Release (decrement of pending count) is owned by dispatchOne's
//     try/finally — never by the turn_done log handler.
//
// Behavior summary:
//   * Debounce rapid bursts into one synthetic message (2s of silence).
//   * Rate-limit at 120 messages / sliding-60s-window per sender.
//   * Cap pending-response depth at 8 (in-flight per sender).
//   * Track abuse across 413 / 429 / 408 and warn every multiple of 25.
//
// All rejections drop silently — operator log only.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type FloodRejectCode = 429 | 413 | 408;

export interface FloodLimits {
  debounceMs:        number;  // default 2_000
  ratePerMin:        number;  // default 120
  maxPending:        number;  // default 8
  maxDebouncedSize:  number;  // default 100_000
  turnTimeoutMs:     number;  // default 60_000
  abuseThreshold:    number;  // default 25
  janitorIntervalMs: number;  // default 60_000
  idleEvictionMs:    number;  // default 5 * 60_000 (5 minutes)
}

export const DEFAULT_FLOOD_LIMITS: FloodLimits = {
  debounceMs:        2_000,
  ratePerMin:        120,
  maxPending:        8,
  maxDebouncedSize:  100_000,
  turnTimeoutMs:     60_000,
  abuseThreshold:    25,
  janitorIntervalMs: 60_000,
  idleEvictionMs:    5 * 60_000,
};

export const DEFAULT_FLOOD_STATE_PATH = join(homedir(), ".nexusclaw", "flood-state.json");

// ---------------------------------------------------------------------------
// Raw inbound shape (what the adapter feeds in) and the synthetic flushed
// shape (what the FloodGuard emits via onFlush).
// ---------------------------------------------------------------------------

export interface RawInbound {
  text:      string;
  chatId:    string;
  topicId?:  string;
  fromUser:  { id: number; username?: string; first_name?: string };
  date:      number;     // unix seconds, from the telegram message
  messageId: number;
}

export interface SyntheticMessage {
  text:      string;     // first.text + "\n" + second.text + …
  chatId:    string;     // from first
  topicId?:  string;     // from first
  fromUser:  { id: number; username?: string; first_name?: string }; // from first
  date:      number;     // from last
  messageId: number;     // from last
  /** How many raw messages were merged into this one. */
  count:     number;
}

export type AcceptResult =
  | { ok: true }
  | { ok: false; code: FloodRejectCode };

// ---------------------------------------------------------------------------
// Per-sender state and in-flight entries
// ---------------------------------------------------------------------------

interface Batch {
  firstMsg: RawInbound;
  lastMsg:  RawInbound;
  texts:    string[];
}

interface SenderState {
  recentTimestamps: number[];                                  // sliding rate window
  abuseCount:       number;                                    // persisted across eviction
  batch:            Batch | undefined;
  batchTimer:       ReturnType<typeof setTimeout> | undefined;
}

interface InFlightEntry {
  userId:     number;
  controller: AbortController;
  emittedAt:  number;
}

function newSenderState(abuseCount = 0): SenderState {
  return {
    recentTimestamps: [],
    abuseCount,
    batch:            undefined,
    batchTimer:       undefined,
  };
}

function flightKey(userId: number, messageId: number): string {
  return `${userId}:${messageId}`;
}

// ---------------------------------------------------------------------------
// FloodGuard
// ---------------------------------------------------------------------------

/**
 * Dispatch callback. The FloodGuard awaits it; resolving signals that the
 * turn is done (so the in-flight slot can free). Adapter implementations
 * typically resolve when they observe a turn_done outbound for the sender.
 *
 * The signal aborts when the janitor finds the entry past its deadline.
 * It should be propagated to agent.chat so the underlying work can stop.
 */
export type OnFlush = (msg: SyntheticMessage, signal: AbortSignal) => Promise<void>;

export interface FloodGuardOptions {
  limits?:        Partial<FloodLimits>;
  /** Override clock for deterministic tests. */
  now?:           () => number;
  /**
   * Path to the abuse-counter persistence file. Defaults to
   * `~/.nexusclaw/flood-state.json`. Pass `null` (not undefined) to disable
   * persistence entirely, useful in tests.
   */
  statePath?:     string | null;
  /** Don't start the periodic janitor — tests may want to drive it. */
  disableJanitor?: boolean;
}

export class FloodGuard {
  private state         = new Map<number, SenderState>();
  private inFlight      = new Map<string, InFlightEntry>();
  private pendingByUser = new Map<number, number>();
  private janitorTimer: ReturnType<typeof setInterval> | undefined;

  private opts: FloodLimits;
  private now:  () => number;
  private statePath: string | null;

  constructor(
    private readonly onFlush: OnFlush,
    o: FloodGuardOptions = {},
  ) {
    this.opts = { ...DEFAULT_FLOOD_LIMITS, ...(o.limits ?? {}) };
    this.now  = o.now ?? (() => Date.now());
    this.statePath = o.statePath === undefined ? DEFAULT_FLOOD_STATE_PATH : o.statePath;
    this.loadPersistedAbuse();
    if (!o.disableJanitor) {
      this.janitorTimer = setInterval(
        () => this.janitorSweep(),
        this.opts.janitorIntervalMs,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /**
   * Try to accept a raw inbound message for the regular agent-bound path.
   * Adds to the per-sender debounce batch on success; the flush will fire
   * after debounceMs of silence.
   */
  tryAccept(msg: RawInbound): AcceptResult {
    const userId = msg.fromUser.id;
    const s = this.stateFor(userId);
    const t = this.now();

    if (!this.consumeRateSlot(s, userId, t)) return { ok: false, code: 429 };

    if ((this.pendingByUser.get(userId) ?? 0) >= this.opts.maxPending) {
      this.recordAbuse(userId, 429, "pending cap");
      return { ok: false, code: 429 };
    }

    if (!s.batch) {
      s.batch = { firstMsg: msg, lastMsg: msg, texts: [msg.text] };
    } else {
      s.batch.lastMsg = msg;
      s.batch.texts.push(msg.text);
    }
    if (s.batchTimer) clearTimeout(s.batchTimer);
    s.batchTimer = setTimeout(() => this.flush(userId), this.opts.debounceMs);

    return { ok: true };
  }

  /**
   * Rate-limit-only path: used for outbound replies that should respect the
   * same per-minute budget as inbound (e.g. pairing prompts), but should NOT
   * be debounced or counted against the pending-cap. Records 429 abuse on
   * miss, exactly like tryAccept.
   */
  tryRateOnly(userId: number): AcceptResult {
    const s = this.stateFor(userId);
    if (!this.consumeRateSlot(s, userId, this.now())) {
      return { ok: false, code: 429 };
    }
    return { ok: true };
  }

  /**
   * Log a turn_done observation from the adapter. **Does not release** —
   * the release is owned by dispatchOne's try/finally. The actual resolve
   * lives in the adapter (per-user awaiting queue); this handler exists
   * only for operator visibility.
   */
  logTurnDone(userId: number): void {
    console.debug(`telegram-flood: turn_done for sender ${userId}`);
  }

  // -------------------------------------------------------------------------
  // Test / introspection helpers
  // -------------------------------------------------------------------------

  abuseCountFor(userId: number): number {
    return this.state.get(userId)?.abuseCount ?? 0;
  }

  pendingFor(userId: number): number {
    return this.pendingByUser.get(userId) ?? 0;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  senderCount(): number {
    return this.state.size;
  }

  /** Force a janitor sweep — used in tests. */
  runJanitor(): void {
    this.janitorSweep();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  stop(): void {
    if (this.janitorTimer) clearInterval(this.janitorTimer);
    this.janitorTimer = undefined;
    for (const s of this.state.values()) {
      if (s.batchTimer) clearTimeout(s.batchTimer);
    }
    // Abort any still-in-flight entries so awaiting dispatches can unwind.
    for (const entry of this.inFlight.values()) {
      entry.controller.abort();
    }
    this.state.clear();
    this.inFlight.clear();
    this.pendingByUser.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private stateFor(userId: number): SenderState {
    let s = this.state.get(userId);
    if (!s) {
      const persisted = this.persistedAbuse.get(userId) ?? 0;
      s = newSenderState(persisted);
      this.state.set(userId, s);
    }
    return s;
  }

  /**
   * Mutates s.recentTimestamps (prunes + maybe appends). Returns true if a
   * slot was consumed; false if the rate limit was already at the cap (in
   * which case a 429 abuse is recorded as a side effect).
   */
  private consumeRateSlot(s: SenderState, userId: number, t: number): boolean {
    const cutoff = t - 60_000;
    while (s.recentTimestamps.length > 0 && s.recentTimestamps[0]! < cutoff) {
      s.recentTimestamps.shift();
    }
    if (s.recentTimestamps.length >= this.opts.ratePerMin) {
      this.recordAbuse(userId, 429, "rate limit");
      return false;
    }
    s.recentTimestamps.push(t);
    return true;
  }

  private flush(userId: number): void {
    const s = this.state.get(userId);
    if (!s || !s.batch) return;
    const batch = s.batch;
    s.batch = undefined;
    s.batchTimer = undefined;

    const text = batch.texts.join("\n");
    if (text.length > this.opts.maxDebouncedSize) {
      this.recordAbuse(userId, 413, `combined size ${text.length} > ${this.opts.maxDebouncedSize}`);
      return;
    }

    const synthetic: SyntheticMessage = {
      text,
      chatId:    batch.firstMsg.chatId,
      topicId:   batch.firstMsg.topicId,
      fromUser:  batch.firstMsg.fromUser,
      date:      batch.lastMsg.date,
      messageId: batch.lastMsg.messageId,
      count:     batch.texts.length,
    };

    void this.dispatchOne(synthetic, userId);
  }

  /**
   * Owns the lifecycle of one in-flight turn. The release (pendingByUser
   * decrement, inFlight delete) happens *only* in finally. The janitor
   * never directly releases — it aborts the controller, which propagates
   * through onFlush and lands here.
   */
  private async dispatchOne(msg: SyntheticMessage, userId: number): Promise<void> {
    const controller = new AbortController();
    const key = flightKey(userId, msg.messageId);
    this.inFlight.set(key, {
      userId,
      controller,
      emittedAt: this.now(),
    });
    this.pendingByUser.set(userId, (this.pendingByUser.get(userId) ?? 0) + 1);

    try {
      await this.onFlush(msg, controller.signal);
    } catch {
      // Best-effort: signal aborted, or downstream rejected. The janitor or
      // the adapter has already logged. Silent here.
    } finally {
      this.inFlight.delete(key);
      const cur = this.pendingByUser.get(userId) ?? 0;
      if (cur <= 1) this.pendingByUser.delete(userId);
      else this.pendingByUser.set(userId, cur - 1);
    }
  }

  private janitorSweep(): void {
    const t = this.now();

    // (a) Abort stuck in-flight entries — let the finally do the release.
    for (const entry of this.inFlight.values()) {
      if (t - entry.emittedAt > this.opts.turnTimeoutMs) {
        this.recordAbuse(entry.userId, 408, "turn timeout (janitor abort)");
        entry.controller.abort();
      }
    }

    // (b) Evict idle senders — only when truly cold. Abuse stays on disk.
    this.evictIdle(t);
  }

  private evictIdle(t: number): void {
    const cutoff = t - 60_000;
    const ageCutoff = t - this.opts.idleEvictionMs;
    for (const [userId, s] of this.state) {
      // Prune expired rate-window timestamps inline.
      while (s.recentTimestamps.length > 0 && s.recentTimestamps[0]! < cutoff) {
        s.recentTimestamps.shift();
      }
      const noBatch   = !s.batch && !s.batchTimer;
      const noPending = (this.pendingByUser.get(userId) ?? 0) === 0;
      const noRecent  = s.recentTimestamps.length === 0;
      // Soft idle (no live state) + cold for at least idleEvictionMs (their
      // last activity timestamp would have been pruned by now).
      if (noBatch && noPending && noRecent && ageCutoff > 0) {
        if (s.abuseCount > 0) this.persistedAbuse.set(userId, s.abuseCount);
        this.state.delete(userId);
      }
    }
  }

  private recordAbuse(userId: number, code: FloodRejectCode, reason: string): void {
    const s = this.stateFor(userId);
    s.abuseCount += 1;
    console.error(
      `telegram-flood: ${code} for sender ${userId} — ${reason} ` +
      `(abuse count ${s.abuseCount})`,
    );
    if (s.abuseCount % this.opts.abuseThreshold === 0) {
      console.error(
        `telegram-flood: WARNING — sender ${userId} has triggered ` +
        `${s.abuseCount} rejections. Consider tightening their access policy.`,
      );
    }
    this.persistedAbuse.set(userId, s.abuseCount);
    this.schedulePersist();
  }

  // -------------------------------------------------------------------------
  // Persistence — abuse counts survive eviction so an attacker can't
  // reset their score by going quiet for five minutes.
  // -------------------------------------------------------------------------

  private persistedAbuse = new Map<number, number>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  private loadPersistedAbuse(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as { telegram?: Record<string, { abuseCount?: number }> };
      const tg = parsed.telegram ?? {};
      for (const [k, v] of Object.entries(tg)) {
        const id = Number(k);
        const n = v?.abuseCount;
        if (Number.isFinite(id) && typeof n === "number") {
          this.persistedAbuse.set(id, n);
        }
      }
    } catch {
      // Corrupt file — start fresh; the next write will overwrite it.
    }
  }

  private schedulePersist(): void {
    if (!this.statePath) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistAbuseNow();
    }, 200);
  }

  private persistAbuseNow(): void {
    if (!this.statePath) return;
    const telegram: Record<string, { abuseCount: number }> = {};
    // Snapshot includes both in-memory state and prior-persisted entries.
    for (const [id, n] of this.persistedAbuse) {
      if (n > 0) telegram[String(id)] = { abuseCount: n };
    }
    for (const [id, s] of this.state) {
      if (s.abuseCount > 0) telegram[String(id)] = { abuseCount: s.abuseCount };
    }
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify({ telegram }, null, 2));
      renameSync(tmp, this.statePath);
    } catch {
      // best-effort
    }
  }
}
