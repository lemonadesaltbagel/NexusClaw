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
  topicId?: string;
}

function makeFakeSender(): { sender: Sender; calls: SenderCall[]; nextId: { v: number } } {
  const calls: SenderCall[] = [];
  const nextId = { v: 1 };
  const sender: Sender = {
    send: async (chatId, text, _replyMarkup, topicId) => {
      calls.push({ op: "send", chatId, text, topicId });
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
  // Disable flood guard by default in tests so existing assertions stay
  // deterministic (no debounce delay, no rate window). Tests that exercise
  // the flood guard pass `flood: { ... }` explicitly.
  const adapter = new TelegramAdapter({ token: "test-token", sender, flood: false, ...opts });
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
    const adapter = new TelegramAdapter({ token: "t", sender, dm, flood: false });
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
    const adapter = new TelegramAdapter({ token: "t", sender, dm, flood: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makeDmUpdate({
      updateId: 1, userId: 99, text: "again",
    }));
    expect(calls[0]!.text).toContain("EXISTCDE");
  });
});

// ---------------------------------------------------------------------------
// stripBotMention — /cmd@botname resolution in groups
// ---------------------------------------------------------------------------

import { stripBotMention } from "@/remote/adapters/telegram";

describe("stripBotMention", () => {
  test("non-command text is returned as-is", () => {
    expect(stripBotMention("hello", "nexusclaw_bot")).toBe("hello");
  });

  test("command with no @ is returned as-is", () => {
    expect(stripBotMention("/clear", "nexusclaw_bot")).toBe("/clear");
    expect(stripBotMention("/echo hello world", "nexusclaw_bot")).toBe("/echo hello world");
  });

  test("command with @ourbot is stripped", () => {
    expect(stripBotMention("/clear@nexusclaw_bot", "nexusclaw_bot")).toBe("/clear");
    expect(stripBotMention("/echo@nexusclaw_bot hi", "nexusclaw_bot")).toBe("/echo hi");
  });

  test("case-insensitive match on bot name", () => {
    expect(stripBotMention("/clear@NexusClaw_Bot", "nexusclaw_bot")).toBe("/clear");
  });

  test("command with @otherbot returns null", () => {
    expect(stripBotMention("/clear@otherbot", "nexusclaw_bot")).toBeNull();
    expect(stripBotMention("/echo@otherbot hi", "nexusclaw_bot")).toBeNull();
  });

  test("returns null for any mention when ourUsername is missing", () => {
    expect(stripBotMention("/clear@anything", undefined)).toBeNull();
  });

  test("/stop@ourbot strips to /stop", () => {
    expect(stripBotMention("/stop@nexusclaw_bot", "nexusclaw_bot")).toBe("/stop");
  });
});

// ---------------------------------------------------------------------------
// Stage 6 — non-text messages dropped after access gate, edits ignored,
// forum routing carries topicId end to end.
// ---------------------------------------------------------------------------

function makePhotoUpdate(opts: {
  updateId: number; chatId: number; fromId: number;
  username?: string; chatType?: "private" | "group" | "supergroup";
}): unknown {
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.updateId * 100,
      date: 1234567890,
      chat: { id: opts.chatId, type: opts.chatType ?? "private" },
      from: {
        id: opts.fromId, is_bot: false, first_name: "U",
        ...(opts.username !== undefined ? { username: opts.username } : {}),
      },
      // No `text` field. A real photo update would have `photo`, but the
      // adapter only checks for the *absence* of text so this is enough.
      photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10 }],
    },
  };
}

function makeEditedUpdate(opts: { updateId: number; userId: number; text: string }): unknown {
  return {
    update_id: opts.updateId,
    edited_message: {
      message_id: opts.updateId * 100,
      date: 1234567890,
      edit_date: 1234567990,
      chat: { id: opts.userId, type: "private" },
      from: { id: opts.userId, is_bot: false, first_name: "U" },
      text: opts.text,
    },
  };
}

describe("non-text messages", () => {
  test("photo from a known DM user is dropped (no event)", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makePhotoUpdate({ updateId: 1, chatId: 42, fromId: 42 }));
    expect(events).toEqual([]);
  });

  test("photo from a stranger under disable is dropped silently (no prompt, no event)", async () => {
    const dm = dmProvider("disable");
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, dm, flood: false });
    const events: RemoteEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makePhotoUpdate({ updateId: 1, chatId: 99, fromId: 99 }));
    expect(events).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("photo from a stranger under pairing triggers the pairing prompt", async () => {
    const dm = dmProvider("pairing");
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, dm, flood: false });
    const events: RemoteEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makePhotoUpdate({
      updateId: 1, chatId: 99, fromId: 99, username: "carol",
    }));
    expect(events).toEqual([]);  // agent never sees the photo
    expect(dm.registerPendingCalls).toHaveLength(1);
    const sent = calls.filter((c) => c.op === "send");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Your Telegram user id: 99");
  });

  test("photo in a non-configured group is dropped silently", async () => {
    const { events, feed } = makeAdapter();
    await feed(makePhotoUpdate({ updateId: 1, chatId: -100, fromId: 42, chatType: "supergroup" }));
    expect(events).toEqual([]);
  });
});

describe("edited messages", () => {
  test("edited_message updates do not produce events", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeEditedUpdate({ updateId: 1, userId: 42, text: "hello, fixed typo" }));
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// /cmd@botname inbound resolution (integration, not just the unit helper)
// ---------------------------------------------------------------------------

describe("group commands with @botname (integration)", () => {
  function makeGroupCommandUpdate(text: string): unknown {
    return {
      update_id: 1,
      message: {
        message_id: 100,
        date: 1234567890,
        chat: { id: -100, type: "supergroup", title: "G" },
        from: { id: 42, is_bot: false, first_name: "U" },
        text,
      },
    };
  }

  function makeBotUsernameInfo(username: string) {
    return { ...BOT_INFO, username };
  }

  test("/clear@ourbot in a configured group → command event with name='clear'", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "open" } } },
    });
    // Inject username we registered as "test"; the helper uses BOT_INFO.username = "test"
    // already, so the command target must match. Use "test".
    await feed(makeGroupCommandUpdate("/clear@test"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "command", name: "clear", args: "" });
  });

  test("/echo@ourbot hello in a configured group → command with name='echo' args='hello'", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "open" } } },
    });
    await feed(makeGroupCommandUpdate("/echo@test hello"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "command", name: "echo", args: "hello" });
  });

  test("/clear@otherbot is silently dropped", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "open" } } },
    });
    await feed(makeGroupCommandUpdate("/clear@some_other_bot"));
    expect(events).toEqual([]);
  });

  // Just double-checks the username helper is what we think it is.
  test("BOT_INFO.username is 'test' (sanity)", () => {
    expect(makeBotUsernameInfo("test").username).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Forum routing — topicId carried on inbound and forwarded on outbound
// ---------------------------------------------------------------------------

describe("forum routing", () => {
  test("inbound forum message carries topicId in RemoteIdentity", async () => {
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
    expect(events[0]!.from).toMatchObject({
      platform: "telegram", userId: "42", chatId: "-100", topicId: "7",
    });
  });

  test("inbound non-forum group message has no topicId", async () => {
    const { events, feed } = makeAdapter({
      access: { groups: { "-100": { policy: "open" } } },
    });
    await feed(makeGroupUpdate({ updateId: 1, chatId: -100, fromId: 42, text: "hi" }));
    expect(events[0]!.from.topicId).toBeUndefined();
  });

  test("outbound text to a forum identity is sent with topicId", async () => {
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, flood: false });
    await adapter.send(
      { platform: "telegram", userId: "42", chatId: "-100", topicId: "7" },
      { kind: "text", delta: "hello" },
    );
    // First delta fires sendFirst — wait a tick.
    await new Promise((r) => setTimeout(r, 5));
    const sent = calls.filter((c) => c.op === "send");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.topicId).toBe("7");
  });

  test("outbound tool_call/system carry topicId to the sender", async () => {
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, flood: false });
    const to = { platform: "telegram", userId: "42", chatId: "-100", topicId: "7" } as const;
    await adapter.send(to, { kind: "tool_call", name: "read_file", input: {} });
    await adapter.send(to, { kind: "system", level: "info", text: "hi" });
    expect(calls.every((c) => c.topicId === "7")).toBe(true);
  });

  test("outbound to a non-forum identity has no topicId on the sender call", async () => {
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, flood: false });
    await adapter.send(
      { platform: "telegram", userId: "42", chatId: "42" },  // plain DM
      { kind: "system", level: "info", text: "hi" },
    );
    expect(calls[0]!.topicId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 7 — obvious-fix items
// ---------------------------------------------------------------------------

import { streamKey } from "@/remote/adapters/telegram";

describe("streamKey", () => {
  test("composes chatId + topicId + userId", () => {
    expect(streamKey({ platform: "telegram", userId: "42", chatId: "-100", topicId: "7" }))
      .toBe("-100:7:42");
  });
  test("blank topic segment when topicId is absent", () => {
    expect(streamKey({ platform: "telegram", userId: "42", chatId: "-100" }))
      .toBe("-100::42");
  });
  test("two users in the same chat produce different keys", () => {
    const a = streamKey({ platform: "telegram", userId: "1", chatId: "-100" });
    const b = streamKey({ platform: "telegram", userId: "2", chatId: "-100" });
    expect(a).not.toBe(b);
  });
});

describe("caption fallback", () => {
  function makeCaptionedPhoto(opts: { updateId: number; userId: number; caption: string }): unknown {
    return {
      update_id: opts.updateId,
      message: {
        message_id: opts.updateId * 100,
        date: 1234567890,
        chat: { id: opts.userId, type: "private" },
        from: { id: opts.userId, is_bot: false, first_name: "U" },
        photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10 }],
        caption: opts.caption,
      },
    };
  }

  test("photo+caption from a known user dispatches the caption as text", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeCaptionedPhoto({ updateId: 1, userId: 42, caption: "summarize this" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", text: "summarize this" });
  });

  test("photo with no text and no caption is still dropped", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed({
      update_id: 1,
      message: {
        message_id: 100,
        date: 1234567890,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "U" },
        photo: [{ file_id: "f1", file_unique_id: "u1", width: 10, height: 10 }],
      },
    });
    expect(events).toEqual([]);
  });
});

describe("empty / whitespace text", () => {
  test("a whitespace-only DM is dropped", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeTextUpdate(1, "   "));
    expect(events).toEqual([]);
  });

  test("a /cmd@otherbot DM that strips to empty is dropped", async () => {
    // stripBotMention returns null for /cmd@otherbot, so this is already
    // covered upstream — but check that mention-stripping plus trim gives
    // the same drop semantics. /clear@test is OUR bot, no stripping
    // produces an empty result, so use a pure-whitespace text instead.
    const dm = dmProvider("open", { known: ["42"] });
    const { events, feed } = makeAdapter({ dm });
    await feed(makeTextUpdate(1, "\n\t  \n"));
    expect(events).toEqual([]);
  });
});

describe("callback_query access gate", () => {
  function makeCallbackUpdate(opts: {
    updateId: number; fromId: number; chatId: number;
    chatType?: "private" | "group" | "supergroup";
    data: string;
  }): unknown {
    return {
      update_id: opts.updateId,
      callback_query: {
        id: String(opts.updateId * 10),
        from: { id: opts.fromId, is_bot: false, first_name: "U" },
        chat_instance: "ci",
        message: {
          message_id: 100,
          date: 1234567890,
          chat: { id: opts.chatId, type: opts.chatType ?? "private" },
          from: { id: 1, is_bot: true, first_name: "Bot" },
          text: "prompt",
        },
        data: opts.data,
      },
    };
  }

  test("callback in a non-configured group is dropped without resolving", async () => {
    // Set up an adapter with a pending prompt, then deliver a callback
    // from an unauthorized group.
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, flood: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // Register a pending prompt so we can detect resolution.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { id } = (adapter as any).prompts.register("confirm");
    // Drive a callback from a group with no policy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makeCallbackUpdate({
      updateId: 1, fromId: 99, chatId: -100, chatType: "supergroup",
      data: `prompt:${id}:allow`,
    }));
    // The pending prompt should still be unresolved.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const remaining = (adapter as any).prompts.resolve(id, "allow");
    expect(remaining).toBe(true); // we just resolved it now — proves it wasn't resolved by the callback
  });

  test("callback in a configured open group is resolved", async () => {
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({
      token: "t", sender, flood: false,
      access: { groups: { "-100": { policy: "open" } } },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { id, promise } = (adapter as any).prompts.register("confirm");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makeCallbackUpdate({
      updateId: 1, fromId: 42, chatId: -100, chatType: "supergroup",
      data: `prompt:${id}:allow`,
    }));
    const reply = await promise;
    expect(reply).toEqual({ kind: "confirm", allowed: true });
  });

  test("DM callback from an unknown user is dropped", async () => {
    const dm = dmProvider("allowlist", { known: ["42"] });
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, dm, flood: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { id } = (adapter as any).prompts.register("confirm");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makeCallbackUpdate({
      updateId: 1, fromId: 99, chatId: 99, data: `prompt:${id}:allow`,
    }));
    // Prompt should still be resolvable from inside.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).prompts.resolve(id, "allow")).toBe(true);
  });

  test("DM callback from a known user resolves the prompt", async () => {
    const dm = dmProvider("allowlist", { known: ["42"] });
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, dm, flood: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { id, promise } = (adapter as any).prompts.register("confirm");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adapter as any).bot.handleUpdate(makeCallbackUpdate({
      updateId: 1, fromId: 42, chatId: 42, data: `prompt:${id}:allow`,
    }));
    const reply = await promise;
    expect(reply).toEqual({ kind: "confirm", allowed: true });
  });
});

describe("multi-user streaming isolation", () => {
  test("two users in the same chat get separate streaming messages", async () => {
    const { sender, calls } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, flood: false });
    const idA = { platform: "telegram", userId: "1", chatId: "-100" } as const;
    const idB = { platform: "telegram", userId: "2", chatId: "-100" } as const;
    await adapter.send(idA, { kind: "text", delta: "from A" });
    await adapter.send(idB, { kind: "text", delta: "from B" });
    // Give sendFirst a microtask cycle.
    await new Promise((r) => setTimeout(r, 5));
    const sends = calls.filter((c) => c.op === "send");
    expect(sends.map((s) => s.text)).toEqual(["from A", "from B"]);
  });

  test("turn_done for one user leaves the other user's stream intact", async () => {
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({ token: "t", sender, flood: false });
    const idA = { platform: "telegram", userId: "1", chatId: "-100" } as const;
    const idB = { platform: "telegram", userId: "2", chatId: "-100" } as const;
    await adapter.send(idA, { kind: "text", delta: "a1" });
    await adapter.send(idB, { kind: "text", delta: "b1" });
    await adapter.send(idA, { kind: "turn_done" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streams: Map<string, unknown> = (adapter as any).streams;
    expect(streams.has(streamKey(idA))).toBe(false);
    expect(streams.has(streamKey(idB))).toBe(true);
  });
});

describe("my_chat_member subscription", () => {
  test("a my_chat_member update is delivered (no event emitted, just logged)", async () => {
    const { events, feed } = makeAdapter();
    await feed({
      update_id: 1,
      my_chat_member: {
        chat: { id: -100, type: "supergroup", title: "G" },
        from: { id: 42, is_bot: false, first_name: "U" },
        date: 1234567890,
        old_chat_member: { user: { id: 1, is_bot: true, first_name: "Bot" }, status: "left" },
        new_chat_member: { user: { id: 1, is_bot: true, first_name: "Bot" }, status: "member" },
      },
    });
    // No RemoteEvent should be emitted.
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage 7 — flood guard end-to-end via the adapter
// ---------------------------------------------------------------------------

describe("flood guard — integration", () => {
  test("two rapid DMs from the same user coalesce into one event", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({
      token: "t", sender, dm,
      flood: { debounceMs: 30 },  // short debounce for the test
    });
    const events: RemoteEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (adapter as any).bot;
    await bot.handleUpdate(makeTextUpdate(1, "hello"));
    await bot.handleUpdate(makeTextUpdate(2, "world"));
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "message", text: "hello\nworld" });
    await adapter.stop();
  });

  test("rate-limit rejection silently drops further messages", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({
      token: "t", sender, dm,
      flood: { debounceMs: 60_000, ratePerMin: 1 },  // long debounce, tiny rate
    });
    const events: RemoteEvent[] = [];
    adapter.onEvent((e) => events.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (adapter as any).bot;
    await bot.handleUpdate(makeTextUpdate(1, "first"));  // ok (still in debounce)
    await bot.handleUpdate(makeTextUpdate(2, "second")); // 429 (rate=1)
    await bot.handleUpdate(makeTextUpdate(3, "third"));  // 429
    // Nothing flushes because debounce is 60s. The point is: events empty (no
    // dispatch), but no exceptions.
    expect(events).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = (adapter as any).flood;
    expect(guard.abuseCountFor(42)).toBe(2);
    await adapter.stop();
  });

  test("turn_done received by adapter frees a pending slot for the sender", async () => {
    const dm = dmProvider("open", { known: ["42"] });
    const { sender } = makeFakeSender();
    const adapter = new TelegramAdapter({
      token: "t", sender, dm,
      flood: { debounceMs: 20, maxPending: 1 },
    });
    adapter.onEvent(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (adapter as any).bot;
    await bot.handleUpdate(makeTextUpdate(1, "hello"));
    await new Promise((r) => setTimeout(r, 40));   // let debounce flush
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = (adapter as any).flood;
    expect(guard.pendingFor(42)).toBe(1);
    // Adapter dispatches turn_done back through send() — simulate it.
    await adapter.send(
      { platform: "telegram", userId: "42", chatId: "42" },
      { kind: "turn_done" },
    );
    // Release runs through a microtask chain: resolve → onFlush returns →
    // dispatchOne's finally fires → pending decrement. Let it settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(guard.pendingFor(42)).toBe(0);
    await adapter.stop();
  });
});

// ---------------------------------------------------------------------------
// Stage 9 — sendPayload / threadId parsing / interactive keyboard
// ---------------------------------------------------------------------------

import {
  parseTelegramThread,
  buildInteractiveKeyboard,
} from "@/remote/adapters/telegram";

describe("parseTelegramThread", () => {
  test("extracts numeric topic from <chatId>:topic:<n>", () => {
    expect(parseTelegramThread("-1001234567890:topic:42")).toBe(42);
  });
  test("returns undefined for undefined input", () => {
    expect(parseTelegramThread(undefined)).toBeUndefined();
  });
  test("returns undefined when the topic suffix is missing", () => {
    expect(parseTelegramThread("-1001234567890")).toBeUndefined();
  });
  test("returns undefined for a non-numeric topic", () => {
    expect(parseTelegramThread("-1001234567890:topic:abc")).toBeUndefined();
  });
});

describe("buildInteractiveKeyboard", () => {
  test("each option becomes a button with callback_data = value", () => {
    const kb = buildInteractiveKeyboard([
      { label: "Approve", value: "approve" },
      { label: "Reject",  value: "reject" },
    ]);
    // grammY's InlineKeyboard exposes `inline_keyboard` as a 2D array.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (kb as any).inline_keyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(rows[0]).toHaveLength(2);
    expect(rows[0]![0]).toMatchObject({ text: "Approve", callback_data: "approve" });
    expect(rows[0]![1]).toMatchObject({ text: "Reject",  callback_data: "reject" });
  });
});

describe("TelegramAdapter.sendPayload", () => {
  interface ApiCall {
    chatId: string;
    text:   string;
    options: Record<string, unknown>;
  }

  function stubAdapter(): { adapter: TelegramAdapter; calls: ApiCall[] } {
    const calls: ApiCall[] = [];
    const adapter = new TelegramAdapter({ token: "t", flood: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (adapter as any).bot;
    bot.botInfo = BOT_INFO;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bot.api.sendMessage = async (chatId: string, text: string, options: Record<string, unknown>) => {
      calls.push({ chatId, text, options });
      return { message_id: 999 };
    };
    return { adapter, calls };
  }

  test("converts markdown to Telegram HTML and sets parse_mode=HTML", async () => {
    const { adapter, calls } = stubAdapter();
    const res = await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      { text: "Done! **README.md** is `up to date`." },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("<b>README.md</b>");
    expect(calls[0]!.text).toContain("<code>up to date</code>");
    expect(calls[0]!.options.parse_mode).toBe("HTML");
    expect(res.messageId).toBe(999);
  });

  test("threadId encoded as <chat>:topic:<n> sets message_thread_id", async () => {
    const { adapter, calls } = stubAdapter();
    await adapter.sendPayload(
      { channel: "telegram", to: "-100", threadId: "-100:topic:7" },
      { text: "hi" },
    );
    expect(calls[0]!.options.message_thread_id).toBe(7);
  });

  test("no threadId → no message_thread_id", async () => {
    const { adapter, calls } = stubAdapter();
    await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      { text: "hi" },
    );
    expect(calls[0]!.options.message_thread_id).toBeUndefined();
  });

  test("interactive prompt attaches reply_markup and appends prompt to body", async () => {
    const { adapter, calls } = stubAdapter();
    await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      {
        text: "Done!",
        interactive: {
          prompt: "Approve the change?",
          options: [
            { label: "Approve", value: "approve" },
            { label: "Reject",  value: "reject"  },
          ],
        },
      },
    );
    expect(calls[0]!.text).toContain("Done!");
    expect(calls[0]!.text).toContain("Approve the change?");
    expect(calls[0]!.options.reply_markup).toBeDefined();
  });

  test("channelData.telegram.quoteText becomes reply_parameters.quote", async () => {
    const { adapter, calls } = stubAdapter();
    await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      {
        text: "Done!",
        channelData: { telegram: { quoteText: "I updated README.md" } },
      },
    );
    const rp = calls[0]!.options.reply_parameters as { quote: string; quote_parse_mode: string };
    expect(rp.quote).toBe("I updated README.md");
    expect(rp.quote_parse_mode).toBe("HTML");
  });

  test("when no quoteText, reply_parameters is omitted", async () => {
    const { adapter, calls } = stubAdapter();
    await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      { text: "hi" },
    );
    expect(calls[0]!.options.reply_parameters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage 10 — chunked sends + retry safety net
// ---------------------------------------------------------------------------

describe("TelegramAdapter.sendPayload — chunked sends", () => {
  interface ApiCall {
    chatId: string;
    text:   string;
    options: Record<string, unknown>;
  }

  function multiChunkAdapter(): { adapter: TelegramAdapter; calls: ApiCall[] } {
    const calls: ApiCall[] = [];
    const adapter = new TelegramAdapter({ token: "t", flood: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (adapter as any).bot;
    bot.botInfo = BOT_INFO;
    let nextId = 1000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bot.api.sendMessage = async (chatId: string, text: string, options: Record<string, unknown>) => {
      calls.push({ chatId, text, options });
      return { message_id: nextId++ };
    };
    return { adapter, calls };
  }

  test("long message produces multiple sendMessage calls, only first carries reply_markup", async () => {
    const { adapter, calls } = multiChunkAdapter();
    // Build a long markdown body that converts to ~9000 chars of HTML.
    const body = "x".repeat(8500);
    await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      {
        text: body,
        interactive: { prompt: "?", options: [{ label: "Y", value: "y" }] },
      },
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.options.reply_markup).toBeDefined();
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]!.options.reply_markup).toBeUndefined();
    }
  });

  test("returns the first chunk's message id even when multiple chunks are sent", async () => {
    const { adapter, calls } = multiChunkAdapter();
    const body = "x".repeat(8500);
    const res = await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      { text: body },
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(res.messageId).toBe(1000);
  });
});

describe("TelegramAdapter.sendPayload — retry safety net", () => {
  interface ApiCall {
    chatId: string;
    text:   string;
    options: Record<string, unknown>;
  }

  function adapterWithFailingFirstCall(fail: { description: string }): {
    adapter: TelegramAdapter;
    calls: ApiCall[];
  } {
    const calls: ApiCall[] = [];
    const adapter = new TelegramAdapter({ token: "t", flood: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bot = (adapter as any).bot;
    bot.botInfo = BOT_INFO;
    let firstAttempt = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bot.api.sendMessage = async (chatId: string, text: string, options: Record<string, unknown>) => {
      calls.push({ chatId, text, options });
      if (firstAttempt) {
        firstAttempt = false;
        const err = new Error(fail.description) as Error & { description: string };
        err.description = fail.description;
        throw err;
      }
      return { message_id: 1234 };
    };
    return { adapter, calls };
  }

  test("parse error → retry with plain text and no parse_mode", async () => {
    const { adapter, calls } = adapterWithFailingFirstCall({
      description: "Bad Request: can't parse entities: …",
    });
    await adapter.sendPayload(
      { channel: "telegram", to: "42" },
      { text: "Hello **world**" },
    );
    expect(calls).toHaveLength(2);
    // First call: HTML body with parse_mode.
    expect(calls[0]!.text).toContain("<b>world</b>");
    expect(calls[0]!.options.parse_mode).toBe("HTML");
    // Retry: plain text body, no parse_mode.
    expect(calls[1]!.text).toBe("Hello world");
    expect(calls[1]!.options.parse_mode).toBeUndefined();
  });

  test("thread-not-found → retry without message_thread_id", async () => {
    const { adapter, calls } = adapterWithFailingFirstCall({
      description: "Bad Request: message thread not found",
    });
    await adapter.sendPayload(
      { channel: "telegram", to: "-100", threadId: "-100:topic:7" },
      { text: "hi" },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.message_thread_id).toBe(7);
    expect(calls[1]!.options.message_thread_id).toBeUndefined();
    // Retry still uses HTML body + parse_mode.
    expect(calls[1]!.options.parse_mode).toBe("HTML");
  });

  test("other errors are rethrown after no retry", async () => {
    const { adapter, calls } = adapterWithFailingFirstCall({
      description: "Bad Request: chat not found",
    });
    await expect(
      adapter.sendPayload({ channel: "telegram", to: "42" }, { text: "hi" }),
    ).rejects.toThrow(/chat not found/);
    expect(calls).toHaveLength(1);
  });
});
