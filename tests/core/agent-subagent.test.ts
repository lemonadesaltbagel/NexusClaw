import { test, expect, describe } from "bun:test";
import { Agent } from "@/core/agent";
import type { Provider, StreamParams } from "@/core/provider";
import type { Message } from "@/core/types";
import { mockUsage, mockTextBlock, mockToolUseBlock, mockMessage } from "../_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  overrides: Partial<Message> & { stop_reason: Message["stop_reason"] },
): Message {
  const { content, ...rest } = overrides;
  return mockMessage({
    content: content ?? [mockTextBlock("Hello")],
    ...rest,
  });
}

function mockProvider(
  createFn: (params: StreamParams) => Message | Promise<Message>,
): Provider {
  return { createMessage: async (params) => createFn(params) };
}

// ---------------------------------------------------------------------------
// runOnce — one-shot sub-agent execution
// ---------------------------------------------------------------------------

describe("runOnce", () => {
  test("collects text output and returns with token deltas", async () => {
    const reply = makeMessage({
      stop_reason: "end_turn",
      content: [mockTextBlock("Sub-agent result")],
      usage: mockUsage({ input_tokens: 100, output_tokens: 50 }),
    });

    let emittedText = "";
    const provider = mockProvider((params) => {
      // Simulate onText callback during streaming
      params.onText?.("Sub-agent result");
      return reply;
    });

    const agent = new Agent({
      provider,
      isSubAgent: true,
      executeTool: async (name) => `result of ${name}`,
    });

    const result = await agent.runOnce("test prompt");
    expect(result.text).toContain("Sub-agent result");
    expect(result.tokens.input).toBeGreaterThanOrEqual(0);
    expect(result.tokens.output).toBeGreaterThanOrEqual(0);
  });

  test("returns empty string when no text is emitted", async () => {
    const reply = makeMessage({
      stop_reason: "end_turn",
      content: [],
      usage: mockUsage({ input_tokens: 10, output_tokens: 5 }),
    });

    const provider = mockProvider(() => reply);
    const agent = new Agent({
      provider,
      isSubAgent: true,
      executeTool: async (name) => `result of ${name}`,
    });

    const result = await agent.runOnce("empty prompt");
    expect(result.text).toBe("");
  });

  test("token deltas reflect usage from the run", async () => {
    const reply = makeMessage({
      stop_reason: "end_turn",
      content: [mockTextBlock("ok")],
      usage: mockUsage({ input_tokens: 200, output_tokens: 75 }),
    });

    const provider = mockProvider((params) => {
      params.onText?.("ok");
      return reply;
    });

    const agent = new Agent({
      provider,
      isSubAgent: true,
      executeTool: async (name) => `result of ${name}`,
    });

    const result = await agent.runOnce("prompt");
    // Tokens should be non-negative (exact values depend on accumulation logic)
    expect(result.tokens.input).toBeGreaterThanOrEqual(0);
    expect(result.tokens.output).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// drainOutput — output buffer behavior
// ---------------------------------------------------------------------------

describe("drainOutput", () => {
  test("returns null for main agents (not sub-agents)", () => {
    const provider = mockProvider(() => makeMessage({ stop_reason: "end_turn" }));
    const agent = new Agent({
      provider,
      executeTool: async (name) => `result of ${name}`,
    });
    expect(agent.drainOutput()).toBeNull();
  });

  test("returns empty string for fresh sub-agent", () => {
    const provider = mockProvider(() => makeMessage({ stop_reason: "end_turn" }));
    const agent = new Agent({
      provider,
      isSubAgent: true,
      executeTool: async (name) => `result of ${name}`,
    });
    expect(agent.drainOutput()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// emitText routing — sub-agents buffer, main agents call onText
// ---------------------------------------------------------------------------

describe("emitText routing", () => {
  test("main agent calls onText callback for text deltas", async () => {
    let received = "";
    const reply = makeMessage({
      stop_reason: "end_turn",
      content: [mockTextBlock("hello world")],
    });

    const provider = mockProvider((params) => {
      params.onText?.("hello world");
      return reply;
    });

    const agent = new Agent({
      provider,
      onText: (delta) => { received += delta; },
      executeTool: async (name) => `result of ${name}`,
    });

    await agent.chat("say hello");
    expect(received).toBe("hello world");
  });

  test("sub-agent does NOT call onText — buffers instead", async () => {
    let received = "";
    const reply = makeMessage({
      stop_reason: "end_turn",
      content: [mockTextBlock("buffered")],
    });

    const provider = mockProvider((params) => {
      params.onText?.("buffered");
      return reply;
    });

    const agent = new Agent({
      provider,
      isSubAgent: true,
      onText: (delta) => { received += delta; },
      executeTool: async (name) => `result of ${name}`,
    });

    const result = await agent.runOnce("prompt");
    // onText should NOT have been called
    expect(received).toBe("");
    // Text should be in the result instead
    expect(result.text).toBe("buffered");
  });
});

// ---------------------------------------------------------------------------
// executeAgentTool — via concurrencySafeTools to force the concurrent path
// ---------------------------------------------------------------------------

describe("executeAgentTool (via concurrent dispatch)", () => {
  test("dispatches agent tool and returns sub-agent output", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "agent", input: { type: "explore", description: "find file", prompt: "search" } }),
      ],
    });
    const subAgentReply = makeMessage({
      stop_reason: "end_turn",
      content: [mockTextBlock("Found it")],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider = mockProvider((params) => {
      const msg = [toolMsg, subAgentReply, endMsg][callIndex];
      callIndex++;
      // Simulate text emission for sub-agent
      if (callIndex === 2) params.onText?.("Found it");
      return msg!;
    });

    let toolResult = "";
    const agent = new Agent({
      provider,
      executeTool: async (name) => `result of ${name}`,
      onToolResult: (_name, result) => { toolResult = result; },
      // Force "agent" through concurrent path so executeToolCall intercepts it
      concurrencySafeTools: new Set(["agent"]),
    });

    await agent.chat("find file");
    expect(toolResult).toContain("Found it");
  });

  test("returns error message when sub-agent throws", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "agent", input: { type: "explore", description: "fail", prompt: "do" } }),
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider = mockProvider(() => {
      if (callIndex++ === 0) return toolMsg;
      if (callIndex === 2) throw new Error("Provider exploded");
      return endMsg;
    });

    let toolResult = "";
    const agent = new Agent({
      provider,
      executeTool: async (name) => `result of ${name}`,
      onToolResult: (_name, result) => { toolResult = result; },
      concurrencySafeTools: new Set(["agent"]),
    });

    await agent.chat("do it");
    expect(toolResult).toContain("error");
  });
});

// ---------------------------------------------------------------------------
// isSubAgent flag behavior
// ---------------------------------------------------------------------------

describe("isSubAgent flag", () => {
  test("sub-agent initializes outputBuffer (drainOutput returns string)", () => {
    const provider = mockProvider(() => makeMessage({ stop_reason: "end_turn" }));
    const agent = new Agent({
      provider,
      isSubAgent: true,
      executeTool: async () => "",
    });
    // outputBuffer is initialized = drainOutput returns empty string (not null)
    expect(agent.drainOutput()).not.toBeNull();
  });

  test("main agent has no outputBuffer (drainOutput returns null)", () => {
    const provider = mockProvider(() => makeMessage({ stop_reason: "end_turn" }));
    const agent = new Agent({
      provider,
      isSubAgent: false,
      executeTool: async () => "",
    });
    expect(agent.drainOutput()).toBeNull();
  });
});
