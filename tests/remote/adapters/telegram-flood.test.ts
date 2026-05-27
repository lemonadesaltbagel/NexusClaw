import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FloodGuard,
  DEFAULT_FLOOD_LIMITS,
  type SyntheticMessage,
  type RawInbound,
} from "@/remote/adapters/telegram-flood";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rawMsg(opts: Partial<RawInbound> & { text: string; userId?: number }): RawInbound {
  return {
    text:      opts.text,
    chatId:    opts.chatId    ?? "42",
    topicId:   opts.topicId,
    fromUser:  opts.fromUser  ?? { id: opts.userId ?? 42 },
    date:      opts.date      ?? 1_700_000_000,
    messageId: opts.messageId ?? 1,
  };
}

function makeGuard(opts: {
  limits?: Partial<typeof DEFAULT_FLOOD_LIMITS>;
  clock?:  { value: number };
  /** Keep onFlush hanging — tests resolve when they want via resolveFlush(). */
  hangOnFlush?: boolean;
  statePath?:   string | null;
} = {}): {
  guard: FloodGuard;
  flushed: SyntheticMessage[];
  signals: AbortSignal[];
  clock: { value: number };
  resolveFlush: (n?: number) => void;
} {
  const flushed: SyntheticMessage[] = [];
  const signals: AbortSignal[] = [];
  const pendingResolves: Array<() => void> = [];
  const clock = opts.clock ?? { value: 1_700_000_000_000 };
  const guard = new FloodGuard(
    (m, signal) => {
      flushed.push(m);
      signals.push(signal);
      if (opts.hangOnFlush) {
        return new Promise<void>((resolve) => {
          pendingResolves.push(resolve);
          // Also resolve when aborted, so dispatchOne's finally runs.
          signal.addEventListener("abort", () => resolve());
        });
      }
      return Promise.resolve();
    },
    {
      limits:         opts.limits,
      now:            () => clock.value,
      statePath:      opts.statePath ?? null,  // default: no persistence in tests
      disableJanitor: true,
    },
  );
  const resolveFlush = (n = 0): void => {
    const r = pendingResolves.splice(n, 1)[0];
    if (r) r();
  };
  return { guard, flushed, signals, clock, resolveFlush };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe("FloodGuard — debounce", () => {
  test("one message flushes after debounceMs", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 30 } });
    expect(guard.tryAccept(rawMsg({ text: "hi", messageId: 1 }))).toEqual({ ok: true });
    await sleep(60);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ text: "hi", count: 1 });
    guard.stop();
  });

  test("two messages within the window coalesce into one with joined text", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 30 } });
    guard.tryAccept(rawMsg({ text: "hello", messageId: 1, date: 100 }));
    guard.tryAccept(rawMsg({ text: "world", messageId: 2, date: 200 }));
    await sleep(60);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.text).toBe("hello\nworld");
    expect(flushed[0]!.count).toBe(2);
    guard.stop();
  });

  test("synthetic uses FIRST sender/chat/topic and LAST date/messageId", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 30 } });
    guard.tryAccept(rawMsg({
      text: "a", messageId: 1, date: 100,
      chatId: "C1", topicId: "T1",
      fromUser: { id: 42, username: "alice" },
    }));
    guard.tryAccept(rawMsg({
      text: "b", messageId: 2, date: 200,
      chatId: "C1", topicId: "T1",
      fromUser: { id: 42, username: "alice" },
    }));
    guard.tryAccept(rawMsg({
      text: "c", messageId: 3, date: 300,
      chatId: "C1", topicId: "T1",
      fromUser: { id: 42, username: "alice" },
    }));
    await sleep(60);
    expect(flushed[0]).toMatchObject({
      text:      "a\nb\nc",
      chatId:    "C1",
      topicId:   "T1",
      date:      300,        // last
      messageId: 3,          // last
    });
    expect(flushed[0]!.fromUser).toMatchObject({ id: 42, username: "alice" });
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

describe("FloodGuard — rate limit (429)", () => {
  test("121st message inside the window is rejected", () => {
    const clock = { value: 1_700_000_000_000 };
    const { guard } = makeGuard({
      limits: { debounceMs: 60_000, ratePerMin: 120 },  // long debounce so we don't flush
      clock,
    });
    for (let i = 0; i < 120; i++) {
      expect(guard.tryAccept(rawMsg({ text: `m${i}`, messageId: i }))).toEqual({ ok: true });
      clock.value += 10;
    }
    expect(guard.tryAccept(rawMsg({ text: "boom", messageId: 121 })))
      .toEqual({ ok: false, code: 429 });
    guard.stop();
  });

  test("after the 60-second window slides, the user can talk again", () => {
    const clock = { value: 1_700_000_000_000 };
    const { guard } = makeGuard({
      limits: { debounceMs: 60_000, ratePerMin: 2 },
      clock,
    });
    expect(guard.tryAccept(rawMsg({ text: "1", messageId: 1 }))).toEqual({ ok: true });
    expect(guard.tryAccept(rawMsg({ text: "2", messageId: 2 }))).toEqual({ ok: true });
    expect(guard.tryAccept(rawMsg({ text: "3", messageId: 3 }))).toEqual({ ok: false, code: 429 });
    clock.value += 60_001;
    expect(guard.tryAccept(rawMsg({ text: "4", messageId: 4 }))).toEqual({ ok: true });
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// tryRateOnly — for pairing prompts, no debouncing, no pending cap
// ---------------------------------------------------------------------------

describe("FloodGuard — tryRateOnly", () => {
  test("respects rate limit but does not enqueue into the debouncer", async () => {
    const clock = { value: 1_700_000_000_000 };
    const { guard, flushed } = makeGuard({
      limits: { debounceMs: 30, ratePerMin: 2 },
      clock,
    });
    expect(guard.tryRateOnly(7)).toEqual({ ok: true });
    expect(guard.tryRateOnly(7)).toEqual({ ok: true });
    expect(guard.tryRateOnly(7)).toEqual({ ok: false, code: 429 });
    // Nothing flushed — tryRateOnly does not enqueue.
    await sleep(60);
    expect(flushed).toEqual([]);
    guard.stop();
  });

  test("shares the same rate window with tryAccept", () => {
    const clock = { value: 1_700_000_000_000 };
    const { guard } = makeGuard({
      limits: { debounceMs: 60_000, ratePerMin: 2 },
      clock,
    });
    expect(guard.tryAccept(rawMsg({ text: "msg", userId: 7, messageId: 1 }))).toEqual({ ok: true });
    expect(guard.tryRateOnly(7)).toEqual({ ok: true });
    expect(guard.tryAccept(rawMsg({ text: "extra", userId: 7, messageId: 2 })))
      .toEqual({ ok: false, code: 429 });
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Pending cap — hangOnFlush keeps dispatch in-flight so we can hit the cap
// ---------------------------------------------------------------------------

describe("FloodGuard — pending cap (429)", () => {
  test("9th flush while 8 are pending is rejected", async () => {
    const { guard, flushed } = makeGuard({
      limits: { debounceMs: 5, maxPending: 8 },
      hangOnFlush: true,
    });
    for (let i = 0; i < 8; i++) {
      guard.tryAccept(rawMsg({ text: `m${i}`, userId: 99, messageId: i }));
      await sleep(15);  // allow each flush to fire before next message
    }
    expect(flushed).toHaveLength(8);
    expect(guard.pendingFor(99)).toBe(8);
    // 9th rejected at the door.
    expect(guard.tryAccept(rawMsg({ text: "extra", userId: 99, messageId: 99 })))
      .toEqual({ ok: false, code: 429 });
    guard.stop();
  });

  test("resolving an onFlush frees a slot via the dispatch finally", async () => {
    const { guard, resolveFlush } = makeGuard({
      limits: { debounceMs: 5, maxPending: 2 },
      hangOnFlush: true,
    });
    guard.tryAccept(rawMsg({ text: "a", userId: 7, messageId: 1 }));
    await sleep(15);
    guard.tryAccept(rawMsg({ text: "b", userId: 7, messageId: 2 }));
    await sleep(15);
    expect(guard.pendingFor(7)).toBe(2);
    // 3rd is rejected.
    expect(guard.tryAccept(rawMsg({ text: "c", userId: 7, messageId: 3 })))
      .toEqual({ ok: false, code: 429 });
    // Resolve the oldest onFlush — dispatchOne's finally releases its slot.
    resolveFlush(0);
    await sleep(20);
    expect(guard.pendingFor(7)).toBe(1);
    expect(guard.tryAccept(rawMsg({ text: "c", userId: 7, messageId: 3 })))
      .toEqual({ ok: true });
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

describe("FloodGuard — size cap (413)", () => {
  test("combined text > maxDebouncedSize triggers 413 at flush", async () => {
    const { guard, flushed } = makeGuard({
      limits: { debounceMs: 20, maxDebouncedSize: 50 },
    });
    guard.tryAccept(rawMsg({ text: "x".repeat(30), userId: 1, messageId: 1 }));
    guard.tryAccept(rawMsg({ text: "y".repeat(30), userId: 1, messageId: 2 }));
    await sleep(50);
    expect(flushed).toEqual([]);
    expect(guard.abuseCountFor(1)).toBeGreaterThanOrEqual(1);
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Janitor + AbortController per turn (408 path)
// ---------------------------------------------------------------------------

describe("FloodGuard — janitor + AbortController", () => {
  test("janitor aborts stuck in-flight entries; abort triggers dispatch finally → release", async () => {
    const clock = { value: 1_000_000 };
    const { guard, signals, resolveFlush } = makeGuard({
      limits: { debounceMs: 5, turnTimeoutMs: 100 },
      clock,
      hangOnFlush: true,
    });
    guard.tryAccept(rawMsg({ text: "stuck", userId: 5, messageId: 1 }));
    await sleep(20);                          // let debounce flush
    expect(guard.pendingFor(5)).toBe(1);
    expect(signals[0]!.aborted).toBe(false);

    // Advance the clock past the deadline; trigger the janitor.
    clock.value += 200;
    guard.runJanitor();

    expect(signals[0]!.aborted).toBe(true);
    expect(guard.abuseCountFor(5)).toBeGreaterThanOrEqual(1);

    // The hangOnFlush onFlush resolves on abort (see helper), so dispatchOne's
    // finally runs and the pending counter releases.
    await sleep(20);
    expect(guard.pendingFor(5)).toBe(0);

    // resolveFlush is no-op now (already auto-resolved by signal).
    resolveFlush(0);
    guard.stop();
  });

  test("turn_done resolution before deadline = no 408", async () => {
    const clock = { value: 1_000_000 };
    const { guard, resolveFlush } = makeGuard({
      limits: { debounceMs: 5, turnTimeoutMs: 200 },
      clock,
      hangOnFlush: true,
    });
    guard.tryAccept(rawMsg({ text: "hi", userId: 6, messageId: 1 }));
    await sleep(20);
    resolveFlush(0);                          // simulate turn_done
    await sleep(20);
    clock.value += 1_000;                     // advance well past deadline
    guard.runJanitor();
    expect(guard.abuseCountFor(6)).toBe(0);
    expect(guard.pendingFor(6)).toBe(0);
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Idle eviction
// ---------------------------------------------------------------------------

describe("FloodGuard — idle eviction", () => {
  test("a fully idle sender is removed from the in-memory state map", async () => {
    const clock = { value: 1_000_000_000 };
    const { guard } = makeGuard({
      limits: { debounceMs: 5, idleEvictionMs: 1_000 },
      clock,
    });
    guard.tryAccept(rawMsg({ text: "hello", userId: 11, messageId: 1 }));
    await sleep(20);                          // flush + complete (no hang)
    expect(guard.senderCount()).toBe(1);
    // Advance past the eviction window AND past the rate window.
    clock.value += 120_000;
    guard.runJanitor();
    expect(guard.senderCount()).toBe(0);
    guard.stop();
  });

  test("an active sender (with batch or in-flight) is NOT evicted", async () => {
    const { guard } = makeGuard({
      limits: { debounceMs: 5 },
      hangOnFlush: true,
    });
    guard.tryAccept(rawMsg({ text: "hi", userId: 13, messageId: 1 }));
    await sleep(20);
    guard.runJanitor();
    expect(guard.senderCount()).toBe(1);    // still active (in-flight)
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Abuse-count persistence
// ---------------------------------------------------------------------------

describe("FloodGuard — abuse-count persistence", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexusclaw-flood-"));
    path = join(dir, "flood-state.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("abuse count is written to disk after a rejection", async () => {
    const clock = { value: 1_700_000_000_000 };
    const guard = new FloodGuard(
      () => Promise.resolve(),
      {
        limits: { debounceMs: 60_000, ratePerMin: 1 },
        now:    () => clock.value,
        statePath: path,
        disableJanitor: true,
      },
    );
    guard.tryAccept(rawMsg({ text: "1", userId: 42, messageId: 1 }));   // ok
    guard.tryAccept(rawMsg({ text: "2", userId: 42, messageId: 2 }));   // 429
    // Persistence is debounced; wait.
    await sleep(300);
    expect(existsSync(path)).toBe(true);
    const json = JSON.parse(readFileSync(path, "utf-8")) as { telegram: Record<string, { abuseCount: number }> };
    expect(json.telegram["42"]?.abuseCount).toBeGreaterThanOrEqual(1);
    guard.stop();
  });

  test("on startup, the abuse counter is restored from disk", () => {
    writeFileSync(path, JSON.stringify({ telegram: { "42": { abuseCount: 50 } } }));
    const guard = new FloodGuard(
      () => Promise.resolve(),
      { statePath: path, disableJanitor: true },
    );
    // The sender state is created lazily on first interaction.
    guard.tryRateOnly(42);
    expect(guard.abuseCountFor(42)).toBe(50);
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Abuse counter cross-code increments + WARN log
// ---------------------------------------------------------------------------

describe("FloodGuard — abuse counter", () => {
  test("counter increments on each reject across codes", () => {
    const clock = { value: 1_700_000_000_000 };
    const { guard } = makeGuard({
      limits: { debounceMs: 60_000, ratePerMin: 1, maxPending: 8 },
      clock,
    });
    guard.tryAccept(rawMsg({ text: "1", userId: 11, messageId: 1 }));      // ok
    expect(guard.abuseCountFor(11)).toBe(0);
    guard.tryAccept(rawMsg({ text: "2", userId: 11, messageId: 2 }));      // 429
    expect(guard.abuseCountFor(11)).toBe(1);
    guard.stop();
  });

  test("WARN log fires at each multiple of abuseThreshold", () => {
    const clock = { value: 1_700_000_000_000 };
    const { guard } = makeGuard({
      limits: { debounceMs: 60_000, ratePerMin: 0, abuseThreshold: 3 },
      clock,
    });
    const origErr = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      for (let i = 0; i < 7; i++) {
        guard.tryAccept(rawMsg({ text: `m${i}`, userId: 12, messageId: i }));
      }
    } finally {
      console.error = origErr;
    }
    const warnings = lines.filter((l) => l.includes("WARNING"));
    expect(warnings).toHaveLength(2);
    guard.stop();
  });
});
