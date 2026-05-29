import { test, expect, describe } from "bun:test";
import { Coordinator } from "@/remote/coordinator";
import type {
  DraftStream,
  OutboundPayload,
  OutboundTarget,
  PlatformAdapter,
  RemoteEvent,
  RemoteIdentity,
  RemoteOutput,
  RemotePrompt,
  RemotePromptReply,
} from "@/remote/types";

interface DraftLog {
  op: "update" | "flush" | "materialize" | "forceNewMessage" | "clear" | "stop";
  arg?: string;
}

function makeFakeDraft(): { draft: DraftStream; log: DraftLog[] } {
  const log: DraftLog[] = [];
  const draft: DraftStream = {
    update(delta) { log.push({ op: "update", arg: delta }); },
    async flush() { log.push({ op: "flush" }); },
    async materialize() { log.push({ op: "materialize" }); },
    forceNewMessage() { log.push({ op: "forceNewMessage" }); },
    async clear() { log.push({ op: "clear" }); },
    async stop()  { log.push({ op: "stop"  }); },
  };
  return { draft, log };
}

function makeFakeAdapter(draft: DraftStream): {
  adapter: PlatformAdapter;
  sentPayloads: Array<{ target: OutboundTarget; payload: OutboundPayload }>;
} {
  const sentPayloads: Array<{ target: OutboundTarget; payload: OutboundPayload }> = [];
  const adapter: PlatformAdapter = {
    name: "telegram",
    async start() {},
    async stop() {},
    onEvent(_h: (e: RemoteEvent) => void): void {},
    async send(_to: RemoteIdentity, _out: RemoteOutput): Promise<void> {},
    async prompt(_p: RemotePrompt): Promise<RemotePromptReply> { throw new Error("nope"); },
    async sendPayload(target, payload) {
      sentPayloads.push({ target, payload });
      return { messageId: 1 };
    },
    draftFor(_target: OutboundTarget): DraftStream { return draft; },
  };
  return { adapter, sentPayloads };
}

const target: OutboundTarget = { channel: "telegram", to: "42" };

describe("Coordinator", () => {
  test("partial mode (default): text deltas update the draft", () => {
    const { draft, log } = makeFakeDraft();
    const { adapter } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target);
    c.text("hello ");
    c.text("world");
    expect(log).toEqual([
      { op: "update", arg: "hello " },
      { op: "update", arg: "world" },
    ]);
  });

  test("turnDone materializes the draft", async () => {
    const { draft, log } = makeFakeDraft();
    const { adapter } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target);
    c.text("hi");
    await c.turnDone();
    expect(log.at(-1)).toEqual({ op: "materialize" });
  });

  test("toolCall materializes draft, then sends a delivery payload", async () => {
    const { draft, log } = makeFakeDraft();
    const { adapter, sentPayloads } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target);
    c.text("starting");
    await c.toolCall("read_file", { path: "/x" });
    expect(log).toEqual([
      { op: "update", arg: "starting" },
      { op: "materialize" },
    ]);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]!.payload.text).toContain("🔧 read_file");
    expect(sentPayloads[0]!.payload.text).toContain('"path":"/x"');
  });

  test("toolResult materializes and sends with status icon", async () => {
    const { draft } = makeFakeDraft();
    const { adapter, sentPayloads } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target);
    await c.toolResult("read_file", "contents", true);
    expect(sentPayloads[0]!.payload.text.startsWith("✓ read_file")).toBe(true);
    await c.toolResult("write_file", "failed", false);
    expect(sentPayloads[1]!.payload.text.startsWith("✗ write_file")).toBe(true);
  });

  test("system maps level to icon and sends as a delivery payload", async () => {
    const { draft } = makeFakeDraft();
    const { adapter, sentPayloads } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target);
    await c.system("info",  "hello");
    await c.system("warn",  "careful");
    await c.system("error", "stop");
    expect(sentPayloads[0]!.payload.text).toContain("ℹ hello");
    expect(sentPayloads[1]!.payload.text).toContain("⚠ careful");
    expect(sentPayloads[2]!.payload.text).toContain("⚠️ stop");
  });

  test("non-partial mode: deltas buffer, turnDone sends one delivery payload", async () => {
    const { draft, log } = makeFakeDraft();
    const { adapter, sentPayloads } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target, { partial: false });
    c.text("hello ");
    c.text("world");
    expect(log.filter((l) => l.op === "update")).toEqual([]);  // no live updates
    await c.turnDone();
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]!.payload.text).toBe("hello world");
  });

  test("clear discards the draft and buffer", async () => {
    const { draft, log } = makeFakeDraft();
    const { adapter } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target, { partial: false });
    c.text("don't send me");
    await c.clear();
    expect(log.at(-1)).toEqual({ op: "clear" });
  });

  test("channelData (e.g. quoteText) is applied to delivery payloads", async () => {
    const { draft } = makeFakeDraft();
    const { adapter, sentPayloads } = makeFakeAdapter(draft);
    const c = new Coordinator(adapter, target, {
      channelData: { telegram: { quoteText: "you said this" } },
    });
    await c.system("info", "ok");
    expect(sentPayloads[0]!.payload.channelData?.telegram?.quoteText).toBe("you said this");
  });
});
