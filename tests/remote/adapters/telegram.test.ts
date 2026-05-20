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
  type Sender,
} from "@/remote/adapters/telegram";
import type { RemoteIdentity } from "@/remote/types";

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
