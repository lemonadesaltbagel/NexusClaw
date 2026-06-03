import { test, expect, describe } from "bun:test";
import type { Agent, PlanApprovalResult } from "@/core/agent";
import { Gateway } from "@/remote/gateway";
import type { AgentCallbacks, AgentFactory } from "@/remote/gateway";
import {
  type PlatformAdapter,
  type RemoteEvent,
  type RemoteIdentity,
  type RemoteOutput,
  type RemotePrompt,
  type RemotePromptReply,
} from "@/remote/types";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface SendRecord { to: RemoteIdentity; out: RemoteOutput }

class FakeAdapter implements PlatformAdapter {
  readonly name = "fake";
  sent: SendRecord[] = [];
  prompts: RemotePrompt[] = [];
  /** Pre-queued replies, consumed in order by prompt(). */
  promptReplies: RemotePromptReply[] = [];
  private handler: ((e: RemoteEvent) => void) | null = null;
  started = false;
  stopped = false;

  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.stopped = true; }
  onEvent(h: (e: RemoteEvent) => void): void { this.handler = h; }
  async send(to: RemoteIdentity, out: RemoteOutput): Promise<void> {
    this.sent.push({ to, out });
  }
  async prompt(p: RemotePrompt): Promise<RemotePromptReply> {
    this.prompts.push(p);
    const r = this.promptReplies.shift();
    if (!r) throw new Error("FakeAdapter.prompt: no queued reply");
    return r;
  }

  async sendPayload(): Promise<{ messageId?: number }> {
    // Not exercised by Gateway tests.
    return {};
  }

  draftFor(): never {
    throw new Error("draftFor not used in Gateway tests");
  }

  /** Test helper — push an event into the gateway. */
  fire(e: RemoteEvent): void {
    if (!this.handler) throw new Error("FakeAdapter has no handler yet");
    this.handler(e);
  }
}

class FakeAgent {
  isProcessing = false;
  aborted = false;
  history: string[] = [];
  /** Raw inputs to chat — preserves the actual shape (string or content array). */
  rawHistory: unknown[] = [];
  planMode = "default";
  compacted = 0;
  costShown = 0;
  /** Callbacks captured at construction. Tests can drive them directly. */
  callbacks!: AgentCallbacks;

  abort(): void { this.aborted = true; this.isProcessing = false; }
  clearHistory(): void { this.history = []; }
  togglePlanMode(): string {
    this.planMode = this.planMode === "plan" ? "default" : "plan";
    return this.planMode;
  }
  async chat(text: unknown): Promise<unknown> {
    this.rawHistory.push(text);
    if (typeof text === "string") this.history.push(text);
    return undefined;
  }
  async compact(): Promise<void> { this.compacted++; }
  showCost(): void { this.costShown++; }
}

function makeFactory(): { factory: AgentFactory; agents: FakeAgent[] } {
  const agents: FakeAgent[] = [];
  const factory: AgentFactory = async (_id, callbacks) => {
    const a = new FakeAgent();
    a.callbacks = callbacks;
    agents.push(a);
    return a as unknown as Agent;
  };
  return { factory, agents };
}

/** Wait for all queued microtasks to run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

const TG: RemoteIdentity = { platform: "telegram", userId: "1", chatId: "1" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gateway — authorization", () => {
  test("rejects unauthorized identities and never builds an agent", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => null, agentFactory: factory });
    gw.registerAdapter(adapter);
    await gw.start();

    adapter.fire({ kind: "message", from: TG, text: "hello" });
    await flush();

    expect(agents).toHaveLength(0);
    const errors = adapter.sent.filter((s) => s.out.kind === "system" && s.out.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.out).toMatchObject({ kind: "system", level: "error", text: "Unauthorized." });
  });
});

describe("Gateway — message routing", () => {
  test("authorized message reaches agent.chat and turn_done is emitted", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({ kind: "message", from: TG, text: "refactor X" });
    await flush();

    expect(agents).toHaveLength(1);
    expect(agents[0]!.history).toEqual(["refactor X"]);
    const turnDone = adapter.sent.find((s) => s.out.kind === "turn_done");
    expect(turnDone).toBeDefined();
  });

  test("agent text/tool callbacks are routed back to originating adapter", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({ kind: "message", from: TG, text: "go" });
    await flush();

    // Drive callbacks as if the agent had streamed during chat().
    const cb = agents[0]!.callbacks;
    // Re-enter a fake turn by manually invoking callbacks — gateway's sink
    // is cleared after chat() returns, so simulate during another chat.
    adapter.sent = [];
    agents[0]!.chat = async () => {
      cb.onText("hello ");
      cb.onText("world");
      cb.onToolCall("read_file", { path: "/x" });
      cb.onToolResult("read_file", "ok");
    };
    adapter.fire({ kind: "message", from: TG, text: "go" });
    await flush();

    const kinds = adapter.sent.map((s) => s.out.kind);
    expect(kinds).toContain("text");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");

    const texts = adapter.sent.filter((s) => s.out.kind === "text").map((s) => (s.out as Extract<RemoteOutput, { kind: "text" }>).delta);
    expect(texts.join("")).toBe("hello world");
  });

  test("inline media content[] is forwarded to agent.chat as anthropic blocks", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({
      kind: "message",
      from: TG,
      text: "look at this",
      content: [
        { type: "text",  text: "look at this" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    });
    await flush();

    expect(agents[0]!.rawHistory).toHaveLength(1);
    expect(agents[0]!.rawHistory[0]).toEqual([
      { type: "text", text: "look at this" },
      {
        type:   "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
    ]);
  });

  test("unsupported image mimeTypes downgrade to a descriptive text block", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({
      kind: "message",
      from: TG,
      text: "",
      content: [
        { type: "image", data: "QUJD", mimeType: "image/heic" },
      ],
    });
    await flush();

    expect(agents[0]!.rawHistory[0]).toEqual([
      { type: "text", text: "[image attachment of unsupported type image/heic]" },
    ]);
  });

  test("message without content[] falls back to the plain text path", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({ kind: "message", from: TG, text: "just text" });
    await flush();

    expect(agents[0]!.rawHistory[0]).toBe("just text");
  });

  test("same canonical user from two identities reuses one Agent", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    // Both identities resolve to canonical user "alice".
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({ kind: "message", from: TG, text: "from telegram" });
    await flush();
    adapter.fire({
      kind: "message",
      from: { platform: "slack", userId: "U1", chatId: "C1" },
      text: "from slack",
    });
    await flush();

    expect(agents).toHaveLength(1);
    expect(agents[0]!.history).toEqual(["from telegram", "from slack"]);
  });
});

describe("Gateway — slash commands", () => {
  test("/clear resets the agent's history", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({ kind: "message", from: TG, text: "first" });
    await flush();
    expect(agents[0]!.history).toEqual(["first"]);

    adapter.fire({ kind: "command", from: TG, name: "clear", args: "" });
    await flush();
    expect(agents[0]!.history).toEqual([]);

    const info = adapter.sent.find((s) => s.out.kind === "system" && (s.out as any).text === "History cleared.");
    expect(info).toBeDefined();
  });

  test("/plan toggles plan mode and reports the new mode", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({ kind: "message", from: TG, text: "hi" }); // forces binding
    await flush();
    adapter.sent = [];

    adapter.fire({ kind: "command", from: TG, name: "plan", args: "" });
    await flush();

    expect(agents[0]!.planMode).toBe("plan");
    const reply = adapter.sent.find((s) => s.out.kind === "system");
    expect((reply!.out as any).text).toBe("Permission mode: plan");
  });

  test("unknown command produces a system reply, not an exception", async () => {
    const { factory } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    adapter.fire({ kind: "command", from: TG, name: "nope-not-a-skill", args: "" });
    await flush();

    const reply = adapter.sent.find(
      (s) => s.out.kind === "system" && (s.out as any).text?.includes("Unknown command"),
    );
    expect(reply).toBeDefined();
  });
});

describe("Gateway — interrupts", () => {
  test("interrupt event calls agent.abort() and bypasses the queue", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    // Force a binding to exist.
    adapter.fire({ kind: "message", from: TG, text: "warm up" });
    await flush();
    agents[0]!.isProcessing = true;

    adapter.fire({ kind: "interrupt", from: TG });
    // Interrupts are synchronous — no queue involved.
    expect(agents[0]!.aborted).toBe(true);
  });

  test("interrupt before any binding exists is a no-op (does not throw)", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    expect(() => adapter.fire({ kind: "interrupt", from: TG })).not.toThrow();
    expect(agents).toHaveLength(0);
  });
});

describe("Gateway — permission bridge", () => {
  test("confirmDangerous is forwarded to adapter.prompt and result returned", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    adapter.promptReplies.push({ kind: "confirm", allowed: true });

    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    const captured: { confirmed: boolean | null } = { confirmed: null };
    // Build a binding, then drive confirmDangerous from inside a turn.
    adapter.fire({ kind: "message", from: TG, text: "warm up" });
    await flush();
    agents[0]!.chat = async () => {
      captured.confirmed = await agents[0]!.callbacks.confirmDangerous("rm -rf?");
    };

    adapter.fire({ kind: "message", from: TG, text: "do dangerous thing" });
    await flush();

    expect(captured.confirmed).toBe(true);
    expect(adapter.prompts).toHaveLength(1);
    expect(adapter.prompts[0]).toMatchObject({ kind: "confirm", message: "rm -rf?" });
  });

  test("planApprovalFn rejects unknown choice as keep-planning", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    adapter.promptReplies.push({ kind: "plan_approval", choiceId: "bogus" });

    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    const captured: { result: PlanApprovalResult | null } = { result: null };
    adapter.fire({ kind: "message", from: TG, text: "warm up" });
    await flush();
    agents[0]!.chat = async () => {
      captured.result = await agents[0]!.callbacks.planApprovalFn("a plan");
    };
    adapter.fire({ kind: "message", from: TG, text: "approve a plan" });
    await flush();

    expect(captured.result).toEqual({ choice: "keep-planning" });
  });

  test("planApprovalFn passes through a valid choice", async () => {
    const { factory, agents } = makeFactory();
    const adapter = new FakeAdapter();
    adapter.promptReplies.push({
      kind: "plan_approval",
      choiceId: "execute",
      feedback: "looks good",
    });

    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    const captured: { result: PlanApprovalResult | null } = { result: null };
    adapter.fire({ kind: "message", from: TG, text: "warm up" });
    await flush();
    agents[0]!.chat = async () => {
      captured.result = await agents[0]!.callbacks.planApprovalFn("a plan");
    };
    adapter.fire({ kind: "message", from: TG, text: "approve" });
    await flush();

    expect(captured.result).toEqual({ choice: "execute", feedback: "looks good" });
  });
});

describe("Gateway — lifecycle", () => {
  test("start() and stop() propagate to adapters", async () => {
    const { factory } = makeFactory();
    const adapter = new FakeAdapter();
    const gw = new Gateway({ resolveIdentity: () => "alice", agentFactory: factory });
    gw.registerAdapter(adapter);

    await gw.start();
    expect(adapter.started).toBe(true);

    await gw.stop();
    expect(adapter.stopped).toBe(true);
  });
});
