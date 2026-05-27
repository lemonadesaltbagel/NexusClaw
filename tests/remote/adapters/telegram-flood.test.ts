import { test, expect, describe } from "bun:test";
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
} = {}): {
  guard: FloodGuard;
  flushed: SyntheticMessage[];
  clock: { value: number };
} {
  const flushed: SyntheticMessage[] = [];
  const clock = opts.clock ?? { value: 1_700_000_000_000 };
  const guard = new FloodGuard(
    (m) => { flushed.push(m); },
    {
      limits: opts.limits,
      now:    () => clock.value,
    },
  );
  return { guard, flushed, clock };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe("FloodGuard — debounce", () => {
  test("one message flushes after debounceMs", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 50 } });
    expect(guard.tryAccept(rawMsg({ text: "hi", messageId: 1 }))).toEqual({ ok: true });
    await sleep(80);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ text: "hi", count: 1 });
    guard.stop();
  });

  test("two messages within the window coalesce into one with joined text", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 50 } });
    guard.tryAccept(rawMsg({ text: "hello", messageId: 1, date: 100 }));
    guard.tryAccept(rawMsg({ text: "world", messageId: 2, date: 200 }));
    await sleep(80);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.text).toBe("hello\nworld");
    expect(flushed[0]!.count).toBe(2);
    guard.stop();
  });

  test("synthetic uses FIRST sender/chat/topic and LAST date/messageId", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 50 } });
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
    await sleep(80);
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

  test("different senders debounce independently", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 50 } });
    guard.tryAccept(rawMsg({ text: "from-1", userId: 1, messageId: 1 }));
    guard.tryAccept(rawMsg({ text: "from-2", userId: 2, messageId: 2 }));
    await sleep(80);
    expect(flushed).toHaveLength(2);
    expect(flushed.map((m) => m.text).sort()).toEqual(["from-1", "from-2"]);
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
      clock.value += 10; // 10ms between
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
    // Advance past the window.
    clock.value += 60_001;
    expect(guard.tryAccept(rawMsg({ text: "4", messageId: 4 }))).toEqual({ ok: true });
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Pending cap
// ---------------------------------------------------------------------------

describe("FloodGuard — pending cap (429)", () => {
  test("9th flush while 8 are pending is rejected", async () => {
    const { guard, flushed } = makeGuard({ limits: { debounceMs: 10, maxPending: 8 } });
    for (let i = 0; i < 8; i++) {
      guard.tryAccept(rawMsg({ text: `m${i}`, userId: i }));  // each sender is its own batch
    }
    await sleep(40);
    // Now 8 flushes have happened for 8 distinct senders. But the cap is
    // per-sender, so 8 from the same sender is what matters. Re-test that.
    expect(flushed).toHaveLength(8);

    // Per-sender variant: 8 turn-flushes from one sender, none acked.
    const single = makeGuard({ limits: { debounceMs: 10, maxPending: 8 } });
    for (let i = 0; i < 8; i++) {
      single.guard.tryAccept(rawMsg({ text: `m${i}`, userId: 99, messageId: i }));
      await sleep(20);  // allow flush before next so each lands in its own batch
    }
    expect(single.guard.pendingFor(99)).toBe(8);
    // 9th attempt — even adding to debounce — is rejected.
    const reject = single.guard.tryAccept(rawMsg({ text: "extra", userId: 99, messageId: 99 }));
    expect(reject).toEqual({ ok: false, code: 429 });
    guard.stop();
    single.guard.stop();
  });

  test("notifyTurnDone frees a slot", async () => {
    const { guard } = makeGuard({ limits: { debounceMs: 10, maxPending: 2 } });
    guard.tryAccept(rawMsg({ text: "a", userId: 7, messageId: 1 }));
    await sleep(30);
    guard.tryAccept(rawMsg({ text: "b", userId: 7, messageId: 2 }));
    await sleep(30);
    expect(guard.pendingFor(7)).toBe(2);
    // 3rd is rejected.
    expect(guard.tryAccept(rawMsg({ text: "c", userId: 7, messageId: 3 })))
      .toEqual({ ok: false, code: 429 });
    // Free one slot.
    guard.notifyTurnDone(7);
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
      limits: { debounceMs: 30, maxDebouncedSize: 50 },
    });
    guard.tryAccept(rawMsg({ text: "x".repeat(30), userId: 1, messageId: 1 }));
    guard.tryAccept(rawMsg({ text: "y".repeat(30), userId: 1, messageId: 2 }));
    await sleep(60);
    expect(flushed).toEqual([]); // dropped at flush
    expect(guard.abuseCountFor(1)).toBeGreaterThanOrEqual(1);
    guard.stop();
  });

  test("a flush under the limit goes through", async () => {
    const { guard, flushed } = makeGuard({
      limits: { debounceMs: 30, maxDebouncedSize: 100 },
    });
    guard.tryAccept(rawMsg({ text: "x".repeat(10), userId: 1, messageId: 1 }));
    await sleep(50);
    expect(flushed).toHaveLength(1);
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Turn timeout (408)
// ---------------------------------------------------------------------------

describe("FloodGuard — turn timeout (408)", () => {
  test("not getting turn_done within turnTimeoutMs counts as 408 abuse", async () => {
    const { guard } = makeGuard({
      limits: { debounceMs: 10, turnTimeoutMs: 30 },
    });
    guard.tryAccept(rawMsg({ text: "hi", userId: 5, messageId: 1 }));
    await sleep(20);  // let debounce flush
    // Pending counter went +1; turn timer started.
    expect(guard.pendingFor(5)).toBe(1);
    await sleep(60);  // exceed turn timeout
    expect(guard.abuseCountFor(5)).toBeGreaterThanOrEqual(1);
    // Pending counter is NOT decremented by the timeout; only by turn_done.
    expect(guard.pendingFor(5)).toBe(1);
    guard.notifyTurnDone(5);
    expect(guard.pendingFor(5)).toBe(0);
    guard.stop();
  });

  test("turn_done before the timeout clears the timer (no 408)", async () => {
    const { guard } = makeGuard({
      limits: { debounceMs: 10, turnTimeoutMs: 100 },
    });
    guard.tryAccept(rawMsg({ text: "hi", userId: 6, messageId: 1 }));
    await sleep(20);
    guard.notifyTurnDone(6);
    await sleep(120);
    expect(guard.abuseCountFor(6)).toBe(0);
    guard.stop();
  });
});

// ---------------------------------------------------------------------------
// Abuse counter
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
    guard.tryAccept(rawMsg({ text: "2", userId: 11, messageId: 2 }));      // 429 (rate)
    expect(guard.abuseCountFor(11)).toBe(1);
    guard.stop();
  });

  test("WARN log fires at each multiple of abuseThreshold", () => {
    const clock = { value: 1_700_000_000_000 };
    const { guard } = makeGuard({
      limits: { debounceMs: 60_000, ratePerMin: 0, abuseThreshold: 3 },
      clock,
    });
    // Capture stderr lines.
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
    // Crossed thresholds at counts 3, 6 → 2 warnings.
    expect(warnings).toHaveLength(2);
    guard.stop();
  });
});
