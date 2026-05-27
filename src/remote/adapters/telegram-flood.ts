// ---------------------------------------------------------------------------
// FloodGuard — adapter-level rate-limit + debounce + queue-depth cap for
// Telegram inbound. Keyed by raw telegram userId.
//
// Behavior summary (see plan stage 7):
//   1. Debounce rapid bursts into one synthetic message (2 s of silence).
//   2. Rate-limit at 120 messages / sliding-60s-window per sender.
//   3. Cap pending-response depth at 8 (queued + in-flight).
//   4. Track abuse across 413 / 429 / 408 and warn on every multiple of 25.
//
// Rejections drop the message silently — operator log only, no user reply.
// ---------------------------------------------------------------------------

export type FloodRejectCode = 429 | 413 | 408;

export interface FloodLimits {
  debounceMs:        number;  // default 2_000
  ratePerMin:        number;  // default 120  (per-sender, sliding 60s)
  maxPending:        number;  // default 8    (per-sender queue depth)
  maxDebouncedSize:  number;  // default 100_000 chars
  turnTimeoutMs:     number;  // default 60_000
  abuseThreshold:    number;  // default 25
}

export const DEFAULT_FLOOD_LIMITS: FloodLimits = {
  debounceMs:        2_000,
  ratePerMin:        120,
  maxPending:        8,
  maxDebouncedSize:  100_000,
  turnTimeoutMs:     60_000,
  abuseThreshold:    25,
};

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
// Per-sender state
// ---------------------------------------------------------------------------

interface Batch {
  firstMsg: RawInbound;
  lastMsg:  RawInbound;
  texts:    string[];
}

interface SenderState {
  recentTimestamps: number[];                       // for sliding rate window
  pending:          number;                         // queued + in-flight count
  abuseCount:       number;
  batch:            Batch | undefined;
  batchTimer:       ReturnType<typeof setTimeout> | undefined;
  turnTimers:       ReturnType<typeof setTimeout>[]; // FIFO of timeouts per emit
}

function newSenderState(): SenderState {
  return {
    recentTimestamps: [],
    pending:          0,
    abuseCount:       0,
    batch:            undefined,
    batchTimer:       undefined,
    turnTimers:       [],
  };
}

// ---------------------------------------------------------------------------
// FloodGuard
// ---------------------------------------------------------------------------

export interface FloodGuardOptions {
  limits?: Partial<FloodLimits>;
  /** Override clock for deterministic tests. */
  now?:    () => number;
}

export class FloodGuard {
  private state = new Map<number, SenderState>();
  private opts:  FloodLimits;
  private now:   () => number;

  constructor(
    private readonly onFlush: (msg: SyntheticMessage) => void,
    o: FloodGuardOptions = {},
  ) {
    this.opts = { ...DEFAULT_FLOOD_LIMITS, ...(o.limits ?? {}) };
    this.now  = o.now ?? (() => Date.now());
  }

  /**
   * Try to accept a raw inbound message. Returns ok or a reject code.
   * Accepted messages are added to the per-sender debounce batch; the
   * caller doesn't need to do anything else with them.
   */
  tryAccept(msg: RawInbound): AcceptResult {
    const userId = msg.fromUser.id;
    const s = this.stateFor(userId);
    const t = this.now();

    // Sliding 60-second rate window.
    const cutoff = t - 60_000;
    while (s.recentTimestamps.length > 0 && s.recentTimestamps[0]! < cutoff) {
      s.recentTimestamps.shift();
    }
    if (s.recentTimestamps.length >= this.opts.ratePerMin) {
      this.recordAbuse(userId, 429, "rate limit");
      return { ok: false, code: 429 };
    }

    // Pending-depth cap.
    if (s.pending >= this.opts.maxPending) {
      this.recordAbuse(userId, 429, "pending cap");
      return { ok: false, code: 429 };
    }

    s.recentTimestamps.push(t);

    // Add to debounce batch.
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
   * Called by the adapter when it sees `turn_done` outbound for this sender.
   * Frees one pending slot. Idempotent for unknown senders.
   */
  notifyTurnDone(userId: number): void {
    const s = this.state.get(userId);
    if (!s) return;
    if (s.pending > 0) s.pending -= 1;
    const t = s.turnTimers.shift();
    if (t) clearTimeout(t);
  }

  /** Test helper — abuse counter for a given sender. */
  abuseCountFor(userId: number): number {
    return this.state.get(userId)?.abuseCount ?? 0;
  }

  /** Test helper — pending count for a given sender. */
  pendingFor(userId: number): number {
    return this.state.get(userId)?.pending ?? 0;
  }

  /** Tear down all timers — used at adapter stop or in test teardown. */
  stop(): void {
    for (const s of this.state.values()) {
      if (s.batchTimer) clearTimeout(s.batchTimer);
      for (const t of s.turnTimers) clearTimeout(t);
    }
    this.state.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private stateFor(userId: number): SenderState {
    let s = this.state.get(userId);
    if (!s) {
      s = newSenderState();
      this.state.set(userId, s);
    }
    return s;
  }

  private flush(userId: number): void {
    const s = this.state.get(userId);
    if (!s || !s.batch) return;
    const batch = s.batch;
    s.batch = undefined;
    s.batchTimer = undefined;

    const text = batch.texts.join("\n");

    // Size cap (413).
    if (text.length > this.opts.maxDebouncedSize) {
      this.recordAbuse(userId, 413, `combined size ${text.length} > ${this.opts.maxDebouncedSize}`);
      return;
    }

    const flushed: SyntheticMessage = {
      text,
      chatId:    batch.firstMsg.chatId,
      topicId:   batch.firstMsg.topicId,
      fromUser:  batch.firstMsg.fromUser,
      date:      batch.lastMsg.date,
      messageId: batch.lastMsg.messageId,
      count:     batch.texts.length,
    };

    s.pending += 1;

    // Turn-timeout (408). Fires only if turn_done doesn't arrive in time.
    const timeoutHandle = setTimeout(() => {
      this.recordAbuse(userId, 408, "turn timeout");
      // intentionally do NOT decrement pending — the eventual turn_done will.
    }, this.opts.turnTimeoutMs);
    s.turnTimers.push(timeoutHandle);

    this.onFlush(flushed);
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
  }
}
