import { test, expect, describe } from "bun:test";
import {
  StreamingMessage,
  PromptRegistry,
  parsePromptCallback,
  parseInboundText,
  renderToolCall,
  renderToolResult,
  renderSystem,
  formatToolInput,
  truncate,
  TelegramAdapter,
  type Sender,
} from "@/remote/adapters/telegram";
import type { RemoteEvent, RemoteIdentity } from "@/remote/types";

const TG: RemoteIdentity = { platform: "telegram", userId: "1", chatId: "100" };

// ---------------------------------------------------------------------------
// Pure renderers
// ---------------------------------------------------------------------------

describe("renderers", () => {
  test("truncate appends a tail count when text exceeds max", () => {
    expect(truncate("a".repeat(10), 5)).toBe("aaaaa\n… (5 more chars)");
  });

  test("truncate leaves short text alone", () => {
    expect(truncate("hi", 100)).toBe("hi");
  });

  test("formatToolInput emits compact JSON", () => {
    expect(formatToolInput({ path: "/x", recursive: true })).toBe(
      '{"path":"/x","recursive":true}',
    );
  });

  test("formatToolInput truncates very long inputs", () => {
    const big = formatToolInput({ data: "x".repeat(500) });
    expect(big.length).toBeLessThanOrEqual(201);
  });

  test("renderToolCall includes name and input", () => {
    expect(renderToolCall("read_file", { path: "/a" })).toBe(`🔧 read_file({"path":"/a"})`);
  });

  test("renderToolResult uses ✓/✗ depending on ok", () => {
    expect(renderToolResult("read_file", "data", true)).toContain("✓ read_file");
    expect(renderToolResult("read_file", "data", false)).toContain("✗ read_file");
  });

  test("renderSystem picks an icon by level", () => {
    expect(renderSystem("info", "hi")).toContain("ℹ");
    expect(renderSystem("warn", "hi")).toContain("⚠");
    expect(renderSystem("error", "hi")).toContain("⚠️");
  });
});

// ---------------------------------------------------------------------------
// Inbound parsing
// ---------------------------------------------------------------------------

describe("parseInboundText", () => {
  test("plain text becomes a message event", () => {
    expect(parseInboundText("hello", TG)).toEqual({ kind: "message", from: TG, text: "hello" });
  });

  test("/stop becomes an interrupt event", () => {
    expect(parseInboundText("/stop", TG)).toEqual({ kind: "interrupt", from: TG });
  });

  test("/<name> becomes a command event with empty args", () => {
    expect(parseInboundText("/clear", TG)).toEqual({
      kind: "command", from: TG, name: "clear", args: "",
    });
  });

  test("/<name> <args> splits name and args", () => {
    expect(parseInboundText("/echo hello world", TG)).toEqual({
      kind: "command", from: TG, name: "echo", args: "hello world",
    });
  });
});

// ---------------------------------------------------------------------------
// Prompt callback parsing
// ---------------------------------------------------------------------------

describe("parsePromptCallback", () => {
  test("parses a well-formed prompt callback", () => {
    expect(parsePromptCallback("prompt:p3:allow")).toEqual({ id: "p3", choice: "allow" });
  });

  test("rejoins choices that contain colons", () => {
    expect(parsePromptCallback("prompt:p1:clear-and-execute")).toEqual({
      id: "p1", choice: "clear-and-execute",
    });
  });

  test("returns null for unrelated callback data", () => {
    expect(parsePromptCallback("nav:home")).toBeNull();
    expect(parsePromptCallback("prompt:p1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PromptRegistry
// ---------------------------------------------------------------------------

describe("PromptRegistry", () => {
  test("resolve translates choice ids for confirm prompts", async () => {
    const r = new PromptRegistry();
    const { id, promise } = r.register("confirm");
    expect(r.resolve(id, "allow")).toBe(true);
    expect(await promise).toEqual({ kind: "confirm", allowed: true });
  });

  test("a 'deny' choice resolves to allowed=false", async () => {
    const r = new PromptRegistry();
    const { id, promise } = r.register("confirm");
    r.resolve(id, "deny");
    expect(await promise).toEqual({ kind: "confirm", allowed: false });
  });

  test("plan_approval forwards the choice id", async () => {
    const r = new PromptRegistry();
    const { id, promise } = r.register("plan_approval");
    r.resolve(id, "execute");
    expect(await promise).toEqual({ kind: "plan_approval", choiceId: "execute" });
  });

  test("an unknown id is a no-op", () => {
    const r = new PromptRegistry();
    expect(r.resolve("nope", "x")).toBe(false);
  });

  test("each register() returns a fresh id", () => {
    const r = new PromptRegistry();
    const a = r.register("confirm");
    const b = r.register("confirm");
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// StreamingMessage — throttled edit-in-place behavior
// ---------------------------------------------------------------------------

interface SenderCall {
  op: "send" | "edit";
  chatId: string;
  messageId?: number;
  text: string;
}

function makeFakeSender(): { sender: Sender; calls: SenderCall[]; nextId: { v: number } } {
  const calls: SenderCall[] = [];
  const nextId = { v: 1 };
  const sender: Sender = {
    send: async (chatId, text) => {
      calls.push({ op: "send", chatId, text });
      return { messageId: nextId.v++ };
    },
    edit: async (chatId, messageId, text) => {
      calls.push({ op: "edit", chatId, messageId, text });
    },
  };
  return { sender, calls, nextId };
}

async function flushTicks(ms = 0): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

describe("StreamingMessage", () => {
  test("first delta sends a new message", async () => {
    const { sender, calls } = makeFakeSender();
    const sm = new StreamingMessage("100", sender, 50);
    sm.pushDelta("hello");
    await flushTicks();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "send", chatId: "100", text: "hello" });
  });

  test("subsequent deltas coalesce into one debounced edit", async () => {
    const { sender, calls } = makeFakeSender();
    const sm = new StreamingMessage("100", sender, 50);
    sm.pushDelta("a");
    await flushTicks();           // first send completes
    sm.pushDelta("b");
    sm.pushDelta("c");
    sm.pushDelta("d");
    await flushTicks(80);          // wait past the throttle window
    const edits = calls.filter((c) => c.op === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.text).toBe("abcd");
  });

  test("finalize flushes any pending edit", async () => {
    const { sender, calls } = makeFakeSender();
    const sm = new StreamingMessage("100", sender, 500); // long throttle
    sm.pushDelta("hi");
    await flushTicks();
    sm.pushDelta(" there");
    await sm.finalize();
    const edits = calls.filter((c) => c.op === "edit");
    expect(edits.at(-1)!.text).toBe("hi there");
  });

  test("finalize without any deltas is a no-op", async () => {
    const { sender, calls } = makeFakeSender();
    const sm = new StreamingMessage("100", sender, 50);
    await sm.finalize();
    expect(calls).toEqual([]);
  });

  test("finalize can be called twice safely", async () => {
    const { sender } = makeFakeSender();
    const sm = new StreamingMessage("100", sender, 50);
    sm.pushDelta("a");
    await sm.finalize();
    await expect(sm.finalize()).resolves.toBeUndefined();
  });

  test("after finalize, a new delta starts a brand-new message", async () => {
    const { sender, calls } = makeFakeSender();
    const sm = new StreamingMessage("100", sender, 50);
    sm.pushDelta("turn1");
    await flushTicks();
    await sm.finalize();

    sm.pushDelta("turn2");
    await flushTicks();
    const sends = calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.text).toBe("turn2");
  });
});

// ---------------------------------------------------------------------------
// Inbound middleware — dedup + sequentialization through grammY's
// bot.handleUpdate, which runs the full middleware/handler stack against a
// synthetic Update without hitting the network.
// ---------------------------------------------------------------------------

const BOT_INFO = {
  id: 1, is_bot: true, first_name: "Test", username: "test",
  can_join_groups: true, can_read_all_group_messages: false,
  supports_inline_queries: false, has_main_web_app: false,
  can_connect_to_business: false,
};

function makeAdapter(opts: Partial<ConstructorParameters<typeof TelegramAdapter>[0]> = {}): {
  adapter: TelegramAdapter;
  events: RemoteEvent[];
  feed: (update: unknown) => Promise<void>;
} {
  const { sender } = makeFakeSender();
  const adapter = new TelegramAdapter({ token: "test-token", sender, ...opts });
  const events: RemoteEvent[] = [];
  adapter.onEvent((e) => events.push(e));
  // Inject botInfo so handleUpdate doesn't try to call getMe over the network.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bot = (adapter as any).bot;
  bot.botInfo = BOT_INFO;
  const feed = (update: unknown): Promise<void> => bot.handleUpdate(update);
  return { adapter, events, feed };
}

function makeTextUpdate(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 100,
      date: 1234567890,
      chat: { id: 42, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice" },
      text,
    },
  };
}

function makeGroupUpdate(opts: {
  updateId: number;
  chatId: number;
  fromId: number;
  text: string;
  type?: "group" | "supergroup";
  threadId?: number;
  isTopicMessage?: boolean;
}): unknown {
  const message: Record<string, unknown> = {
    message_id: opts.updateId * 100,
    date: 1234567890,
    chat: { id: opts.chatId, type: opts.type ?? "supergroup", title: "G" },
    from: { id: opts.fromId, is_bot: false, first_name: "U" },
    text: opts.text,
  };
  if (opts.threadId !== undefined) message.message_thread_id = opts.threadId;
  if (opts.isTopicMessage)         message.is_topic_message = true;
  return { update_id: opts.updateId, message };
}

describe("inbound middleware — dedup", () => {
  test("a duplicate update_id is discarded; only one event fires", async () => {
    const { events, feed } = makeAdapter();
    const dup = makeTextUpdate(1, "hello");
    await Promise.all([feed(dup), feed(dup)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", text: "hello" });
  });

  test("distinct update_ids both produce events", async () => {
    const { events, feed } = makeAdapter();
    await feed(makeTextUpdate(1, "first"));
    await feed(makeTextUpdate(2, "second"));
    expect(events).toHaveLength(2);
  });

  test("after one update completes, its id is freed so a later re-use is dispatched", async () => {
    const { events, feed } = makeAdapter();
    await feed(makeTextUpdate(1, "first"));
    // Same id replayed after completion is no longer considered "pending".
    await feed(makeTextUpdate(1, "again"));
    expect(events).toHaveLength(2);
  });
});

describe("inbound middleware — ordering", () => {
  test("concurrent updates dispatch in submission order", async () => {
    const { events, feed } = makeAdapter();
    const N = 10;
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) promises.push(feed(makeTextUpdate(i + 1, `msg ${i}`)));
    await Promise.all(promises);
    expect(events).toHaveLength(N);
    const texts = events.map((e) => (e.kind === "message" ? e.text : ""));
    expect(texts).toEqual(Array.from({ length: N }, (_, i) => `msg ${i}`));
  });
});

// ---------------------------------------------------------------------------
// Access control — self-message drop + group / forum policy enforcement
// ---------------------------------------------------------------------------

describe("access control — self messages", () => {
  test("messages from the bot itself are dropped", async () => {
    const { events, feed } = makeAdapter();
    const update = {
      update_id: 1,
      message: {
        message_id: 100,
        date: 1234567890,
        chat: { id: 42, type: "private" },
        from: { id: BOT_INFO.id, is_bot: true, first_name: "Test" },
        text: "echo",
      },
    };
    await feed(update);
    expect(events).toEqual([]);
  });
});

describe("access control — groups", () => {
  test("unconfigured group → message dropped", async () => {
    const { events, feed } = makeAdapter();
    await feed(makeGroupUpdate({ updateId: 1, chatId: -100, fromId: 42, text: "hi" }));
    expect(events).toEqual([]);
  });

  test("policy=open → message dispatched", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "open" } } },
    });
    await feed(makeGroupUpdate({ updateId: 1, chatId: -100, fromId: 42, text: "hi" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", text: "hi" });
  });

  test("policy=disabled → message dropped", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "disabled" } } },
    });
    await feed(makeGroupUpdate({ updateId: 1, chatId: -100, fromId: 42, text: "hi" }));
    expect(events).toEqual([]);
  });

  test("policy=allowlist + user listed → dispatched", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "allowlist", allowedUsers: ["42"] } } },
    });
    await feed(makeGroupUpdate({ updateId: 1, chatId: -100, fromId: 42, text: "hi" }));
    expect(events).toHaveLength(1);
  });

  test("policy=allowlist + user NOT listed → dropped", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "allowlist", allowedUsers: ["42"] } } },
    });
    await feed(makeGroupUpdate({ updateId: 1, chatId: -100, fromId: 99, text: "hi" }));
    expect(events).toEqual([]);
  });
});

describe("access control — forums", () => {
  test("topic enabled + policy=open → dispatched", async () => {
    const { events, feed } = makeAdapter({
      access: {
        groups: { "-100": { policy: "open", topics: { "7": { enabled: true } } } },
      },
    });
    await feed(makeGroupUpdate({
      updateId: 1, chatId: -100, fromId: 42, text: "hi",
      threadId: 7, isTopicMessage: true,
    }));
    expect(events).toHaveLength(1);
  });

  test("topic disabled → dropped", async () => {
    const { events, feed } = makeAdapter({
      access: {
        groups: { "-100": { policy: "open", topics: { "7": { enabled: false } } } },
      },
    });
    await feed(makeGroupUpdate({
      updateId: 1, chatId: -100, fromId: 42, text: "hi",
      threadId: 7, isTopicMessage: true,
    }));
    expect(events).toEqual([]);
  });

  test("topic not configured → dropped (even with policy=open)", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "open" } } },
    });
    await feed(makeGroupUpdate({
      updateId: 1, chatId: -100, fromId: 42, text: "hi",
      threadId: 7, isTopicMessage: true,
    }));
    expect(events).toEqual([]);
  });
});

describe("access control — DMs flow through unchanged", () => {
  test("a private message dispatches even with no access settings", async () => {
    const { events, feed } = makeAdapter();
    await feed(makeTextUpdate(1, "hi from dm"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", text: "hi from dm" });
  });
});

// ---------------------------------------------------------------------------
// DM access policy — exercises the full adapter wiring through the DM
// AccessProvider interface.
// ---------------------------------------------------------------------------

import type { DmAccessProvider } from "@/remote/adapters/telegram";
import type { DmPolicyKind } from "@/remote/adapters/telegram-dm";

interface FakeDm extends DmAccessProvider {
  registerPendingCalls: Array<{ userId: string; username?: string; firstName?: string }>;
  registerKnownCalls:   Array<{ userId: string; username?: string }>;
}

function dmProvider(policy: DmPolicyKind, opts: {
  known?: string[]; pending?: Map<string, string>;
} = {}): FakeDm {
  const known   = new Set(opts.known ?? []);
  const pending = opts.pending ?? new Map<string, string>();
  const registerPendingCalls: Array<{ userId: string; username?: string; firstName?: string }> = [];
  const registerKnownCalls:   Array<{ userId: string; username?: string }> = [];
  let counter = 0;
  return {
    policy,
    isKnown:   (id) => known.has(id),
    isPending: (id) => pending.has(id),
    registerPending: (req) => {
      const existing = pending.get(req.userId);
      if (existing) return existing;
      counter += 1;
      const code = `CODE${counter.toString().padStart(4, "0")}`;
      pending.set(req.userId, code);
      registerPendingCalls.push(req);
      return code;
    },
    registerKnown: (req) => {
      known.add(req.userId);
      registerKnownCalls.push(req);
    },
    registerPendingCalls,
    registerKnownCalls,
  };
}

function makeDmUpdate(opts: {
  updateId: number; userId: number; text: string;
  username?: string; firstName?: string;
}): unknown {
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.updateId * 100,
      date: 1234567890,
      chat: { id: opts.userId, type: "private", first_name: opts.firstName ?? "U" },
      from: {
        id: opts.userId,
        is_bot: false,
        first_name: opts.firstName ?? "U",
        username: opts.username,
      },
      text: opts.text,
    },
  };
}

describe("dm policy — disable", () => {
  test("drops every DM", async () => {
    const dm = dmProvider("disable", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeDmUpdate({ updateId: 1, userId: 42, text: "hi" }));
    expect(events).toEqual([]);
  });
});

describe("dm policy — open", () => {
  test("known user → dispatched, no registerKnown call", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeDmUpdate({ updateId: 1, userId: 42, text: "hi" }));
    expect(events).toHaveLength(1);
    expect(dm.registerKnownCalls).toEqual([]);
  });

  test("stranger → registered then dispatched", async () => {
    const dm = dmProvider("open");
    const { events, feed } = makeAdapter({ dm });
    await feed(makeDmUpdate({ updateId: 1, userId: 99, username: "carol", text: "first time" }));
    expect(dm.registerKnownCalls).toEqual([{ userId: "99", username: "carol" }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", text: "first time" });
  });
});

describe("dm policy — allowlist", () => {
  test("known user → dispatched", async () => {
    const dm = dmProvider("allowlist", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeDmUpdate({ updateId: 1, userId: 42, text: "hi" }));
    expect(events).toHaveLength(1);
  });

  test("stranger → dropped, nothing dispatched, nothing registered", async () => {
    const dm = dmProvider("allowlist");
    const { events, feed } = makeAdapter({ dm });
    await feed(makeDmUpdate({ updateId: 1, userId: 99, text: "hi" }));
    expect(events).toEqual([]);
    expect(dm.registerKnownCalls).toEqual([]);
    expect(dm.registerPendingCalls).toEqual([]);
  });
});

describe("dm policy — pairing", () => {
  test("known user → dispatched", async () => {
    const dm = dmProvider("pairing", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeDmUpdate({ updateId: 1, userId: 42, text: "hi" }));
    expect(events).toHaveLength(1);
  });

  test("stranger → no agent dispatch; registerPending called; pairing prompt sent", async () => {
    const dm = dmProvider("pairing");
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, dm });
    const events: RemoteEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makeDmUpdate({
      updateId: 1, userId: 99, username: "carol", firstName: "Carol", text: "hello",
    }));

    expect(events).toEqual([]);  // no agent dispatch
    expect(dm.registerPendingCalls).toEqual([
      { userId: "99", username: "carol", firstName: "Carol" },
    ]);
    const sent = calls.filter((c) => c.op === "send");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Your Telegram user id: 99");
    expect(sent[0]!.text).toContain("CODE0001");
    expect(sent[0]!.text).toContain("nexusclaw pairing approve telegram CODE0001");
  });

  test("stranger re-DMing reuses the same code", async () => {
    const pending = new Map<string, string>();
    const dm = dmProvider("pairing", { pending });
    pending.set("99", "EXISTCDE");  // pretend a code already exists for this user
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, dm });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makeDmUpdate({
      updateId: 1, userId: 99, text: "again",
    }));
    expect(calls[0]!.text).toContain("EXISTCDE");
  });
});
