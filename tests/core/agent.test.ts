import { test, expect, describe, mock } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "@/core/agent";
import {
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  THINKING_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
  MAX_COMPACT_RETRIES,
  type Message,
} from "@/core/types";

// ---------------------------------------------------------------------------
// Helpers — mock Anthropic client with controllable stream responses
// ---------------------------------------------------------------------------

/** Build a minimal Message object. */
function makeMessage(
  overrides: Partial<Message> & { stop_reason: Message["stop_reason"] },
): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250514",
    content: overrides.content ?? [{ type: "text", text: "Hello" }],
    stop_reason: overrides.stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

/** Create a fake stream that resolves to `msg` and captures `on("text")` calls. */
function fakeStream(msg: Message, opts?: { textDeltas?: string[] }) {
  let textCb: ((delta: string) => void) | null = null;
  return {
    on(event: string, cb: (delta: string) => void) {
      if (event === "text") textCb = cb;
    },
    async finalMessage() {
      // Fire text deltas if provided
      if (opts?.textDeltas && textCb) {
        for (const d of opts.textDeltas) textCb(d);
      }
      return msg;
    },
  };
}

/** Build a mock Anthropic client whose `.messages.stream()` calls `streamFn`. */
function mockClient(streamFn: (...args: unknown[]) => unknown): Anthropic {
  return {
    messages: { stream: streamFn },
  } as unknown as Anthropic;
}

// ---------------------------------------------------------------------------
// 1. Core agent loop — end_turn completion
// ---------------------------------------------------------------------------

describe("core loop", () => {
  test("end_turn returns response and appends user message to history", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const client = mockClient(() => fakeStream(msg));

    const agent = new Agent({ client });
    const result = await agent.chatAnthropic("Hi");

    expect(result.response).toBe(msg);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Hi" });
  });

  test("stop_sequence is treated like end_turn", async () => {
    const msg = makeMessage({ stop_reason: "stop_sequence" });
    const client = mockClient(() => fakeStream(msg));

    const agent = new Agent({ client });
    const result = await agent.chatAnthropic("Hey");

    expect(result.response.stop_reason).toBe("stop_sequence");
  });
});

// ---------------------------------------------------------------------------
// 2. Tool use dispatch — serial execution, error handling
// ---------------------------------------------------------------------------

describe("tool use", () => {
  test("executes tools serially and continues until end_turn", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Using tool" },
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
        { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "b.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callCount = 0;
    const client = mockClient(() => {
      callCount++;
      return fakeStream(callCount === 1 ? toolMsg : endMsg);
    });

    const executionOrder: string[] = [];
    const agent = new Agent({
      client,
      executeTool: async (_name, input) => {
        executionOrder.push((input as { path: string }).path);
        return `content of ${(input as { path: string }).path}`;
      },
    });

    const result = await agent.chatAnthropic("Read files");

    expect(executionOrder).toEqual(["a.txt", "b.txt"]);
    expect(result.response.stop_reason).toBe("end_turn");
    // Messages: user, assistant (tool_use), user (tool_results), user (implicit from 2nd turn is the same "Read files")
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });

  test("tool execution errors are caught and reported", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "bad_tool", input: {} },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callCount = 0;
    const client = mockClient(() => {
      callCount++;
      return fakeStream(callCount === 1 ? toolMsg : endMsg);
    });

    const agent = new Agent({
      client,
      executeTool: async () => {
        throw new Error("tool broke");
      },
    });

    const result = await agent.chatAnthropic("Do thing");
    // Should complete without throwing
    expect(result.response.stop_reason).toBe("end_turn");

    // The tool result message should contain the error
    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(toolResultMsg).toBeDefined();
    const content = (toolResultMsg!.content as Array<{ type: string; content?: string }>).find(
      (b) => b.type === "tool_result",
    );
    expect(content?.content).toContain("tool broke");
  });

  test("default executeTool returns not-implemented message", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "unknown_tool", input: {} },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callCount = 0;
    const client = mockClient(() => {
      callCount++;
      return fakeStream(callCount === 1 ? toolMsg : endMsg);
    });

    const agent = new Agent({ client });
    const result = await agent.chatAnthropic("Do thing");

    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    const content = (toolResultMsg!.content as Array<{ type: string; content?: string }>).find(
      (b) => b.type === "tool_result",
    );
    expect(content?.content).toContain("not implemented");
  });
});

// ---------------------------------------------------------------------------
// 3. max_tokens — escalation and recovery
// ---------------------------------------------------------------------------

describe("max_tokens recovery", () => {
  test("first truncation escalates max_tokens from default to 4x", async () => {
    const truncMsg = makeMessage({ stop_reason: "max_tokens" });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callCount = 0;
    let capturedMaxTokens: number[] = [];
    const client = mockClient((params: Record<string, unknown>) => {
      callCount++;
      capturedMaxTokens.push(params.max_tokens as number);
      return fakeStream(callCount === 1 ? truncMsg : endMsg);
    });

    const agent = new Agent({ client });
    await agent.chatAnthropic("Write essay");

    expect(capturedMaxTokens[0]).toBe(DEFAULT_MAX_TOKENS);
    expect(capturedMaxTokens[1]).toBe(ESCALATED_MAX_TOKENS);
  });

  test("after escalation, uses recovery retries up to MAX_RECOVERY_RETRIES then returns", async () => {
    const truncMsg = makeMessage({ stop_reason: "max_tokens" });

    let callCount = 0;
    const client = mockClient(() => {
      callCount++;
      return fakeStream(truncMsg);
    });

    const agent = new Agent({ client });
    const result = await agent.chatAnthropic("Very long essay");

    // 1 initial + 1 escalation + MAX_RECOVERY_RETRIES = total calls
    expect(callCount).toBe(2 + MAX_RECOVERY_RETRIES);
    expect(result.response.stop_reason).toBe("max_tokens");
  });
});

// ---------------------------------------------------------------------------
// 4. pause_turn — token budget continuation
// ---------------------------------------------------------------------------

describe("pause_turn", () => {
  test("pause_turn injects continuation prompt and retries", async () => {
    const pauseMsg = makeMessage({ stop_reason: "pause_turn" });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callCount = 0;
    const client = mockClient(() => {
      callCount++;
      return fakeStream(callCount === 1 ? pauseMsg : endMsg);
    });

    const agent = new Agent({ client });
    const result = await agent.chatAnthropic("Continue");

    expect(callCount).toBe(2);
    expect(result.response.stop_reason).toBe("end_turn");

    // Check continuation message was injected
    const lastUserMsg = result.messages.filter((m) => m.role === "user").pop();
    // The last user message could be the original or the continuation; there should be a continuation
    const hasContinuation = result.messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("token budget"),
    );
    expect(hasContinuation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Prompt-too-long recovery — collapse → compact → throw
// ---------------------------------------------------------------------------

describe("prompt too long recovery", () => {
  test("first PTL error triggers collapseContext", async () => {
    const ptlError = new Anthropic.BadRequestError(
      "prompt is too long",
      { status: 400, headers: {} as any, error: undefined, request: {} as any, body: undefined },
      undefined as any,
    );

    let callCount = 0;
    let collapseCount = 0;
    const client = mockClient(() => {
      callCount++;
      if (callCount === 1) throw ptlError;
      return fakeStream(makeMessage({ stop_reason: "end_turn" }));
    });

    const agent = new Agent({
      client,
      collapseContext: async (msgs) => {
        collapseCount++;
        return msgs;
      },
    });

    await agent.chatAnthropic("Big message");
    expect(collapseCount).toBe(1);
  });

  test("after collapse, PTL triggers compactMessages", async () => {
    const ptlError = new Anthropic.BadRequestError(
      "prompt is too long",
      { status: 400, headers: {} as any, error: undefined, request: {} as any, body: undefined },
      undefined as any,
    );

    let callCount = 0;
    let compactCount = 0;
    const client = mockClient(() => {
      callCount++;
      if (callCount <= 2) throw ptlError; // fail on collapse + first compact
      return fakeStream(makeMessage({ stop_reason: "end_turn" }));
    });

    const agent = new Agent({
      client,
      compactMessages: async (msgs) => {
        compactCount++;
        return msgs;
      },
    });

    await agent.chatAnthropic("Big message");
    expect(compactCount).toBe(1);
  });

  test("exhausting all PTL retries throws the withheld error", async () => {
    const ptlError = new Anthropic.BadRequestError(
      "prompt is too long",
      { status: 400, headers: {} as any, error: undefined, request: {} as any, body: undefined },
      undefined as any,
    );

    const client = mockClient(() => {
      throw ptlError;
    });

    const agent = new Agent({ client });

    // 1 collapse + MAX_COMPACT_RETRIES compactions, then throw
    await expect(agent.chatAnthropic("Huge")).rejects.toThrow("prompt is too long");
  });

  test("non-PTL errors propagate immediately", async () => {
    const client = mockClient(() => {
      throw new Error("network failure");
    });

    const agent = new Agent({ client });
    await expect(agent.chatAnthropic("Msg")).rejects.toThrow("network failure");
  });
});

// ---------------------------------------------------------------------------
// 6. Streaming — onText callback
// ---------------------------------------------------------------------------

describe("streaming", () => {
  test("onText receives text deltas from stream", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const client = mockClient(() => fakeStream(msg, { textDeltas: ["Hel", "lo", " world"] }));

    const deltas: string[] = [];
    const agent = new Agent({
      client,
      onText: (d) => deltas.push(d),
    });

    await agent.chatAnthropic("Hi");
    expect(deltas).toEqual(["Hel", "lo", " world"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Stop hook
// ---------------------------------------------------------------------------

describe("stop hook", () => {
  test("checkStopHook blocking injects continue signal and retries", async () => {
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let hookCalls = 0;
    let callCount = 0;
    const client = mockClient(() => {
      callCount++;
      return fakeStream(endMsg);
    });

    const agent = new Agent({
      client,
      checkStopHook: async () => {
        hookCalls++;
        return hookCalls === 1; // block first time, allow second
      },
    });

    const result = await agent.chatAnthropic("Do task");

    expect(hookCalls).toBe(2);
    expect(callCount).toBe(2);

    const hasContinuation = result.messages.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("not yet complete"),
    );
    expect(hasContinuation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. AbortController — chat() / abort() lifecycle
// ---------------------------------------------------------------------------

describe("abort controller", () => {
  test("chat() wraps chatAnthropic with abort controller lifecycle", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedSignal: AbortSignal | undefined;

    const client = mockClient((_params: unknown, opts: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return fakeStream(msg);
    });

    const agent = new Agent({ client });
    await agent.chat("Hello");

    // Signal was passed to stream
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
  });

  test("abort() aborts the in-flight signal", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedSignal: AbortSignal | undefined;
    let resolveStream: (() => void) | null = null;

    const client = mockClient((_params: unknown, opts: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return {
        on() {},
        finalMessage() {
          return new Promise<Message>((resolve) => {
            resolveStream = () => resolve(msg);
          });
        },
      };
    });

    const agent = new Agent({ client });
    const chatPromise = agent.chat("Hello");

    // Abort while streaming
    agent.abort();
    expect(capturedSignal!.aborted).toBe(true);

    // Resolve to let chat() finish
    resolveStream!();
    await chatPromise;
  });

  test("abort skips remaining tools in handleNextTurn", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "tool_a", input: {} },
        { type: "tool_use", id: "tu_2", name: "tool_b", input: {} },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callCount = 0;
    let abortSignalRef: AbortSignal | undefined;
    const client = mockClient((_params: unknown, opts: { signal?: AbortSignal }) => {
      callCount++;
      if (callCount === 1) abortSignalRef = opts?.signal;
      return fakeStream(callCount === 1 ? toolMsg : endMsg);
    });

    const executed: string[] = [];
    const agent = new Agent({
      client,
      executeTool: async (name) => {
        // Abort after the first tool executes
        if (name === "tool_a") {
          agent.abort();
        }
        executed.push(name);
        return "ok";
      },
    });

    await agent.chat("Do things");

    // tool_a ran, tool_b should have been skipped due to abort
    expect(executed).toEqual(["tool_a"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Thinking mode
// ---------------------------------------------------------------------------

describe("thinking mode", () => {
  test("enabled mode sends thinking param and raises max_tokens", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: Record<string, unknown> = {};
    const client = mockClient((params: Record<string, unknown>) => {
      capturedParams = params;
      return fakeStream(msg);
    });

    const agent = new Agent({ client, thinkingMode: "enabled" });
    await agent.chatAnthropic("Think hard");

    expect(capturedParams.max_tokens).toBe(THINKING_MAX_TOKENS);
    expect(capturedParams.thinking).toEqual({
      type: "enabled",
      budget_tokens: THINKING_MAX_TOKENS - 1,
    });
  });

  test("adaptive mode sends thinking param with 10k budget", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: Record<string, unknown> = {};
    const client = mockClient((params: Record<string, unknown>) => {
      capturedParams = params;
      return fakeStream(msg);
    });

    const agent = new Agent({ client, thinkingMode: "adaptive" });
    await agent.chatAnthropic("Think a bit");

    expect(capturedParams.max_tokens).toBe(THINKING_MAX_TOKENS);
    expect(capturedParams.thinking).toEqual({
      type: "enabled",
      budget_tokens: 10_000,
    });
  });

  test("disabled mode does not send thinking param", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: Record<string, unknown> = {};
    const client = mockClient((params: Record<string, unknown>) => {
      capturedParams = params;
      return fakeStream(msg);
    });

    const agent = new Agent({ client, thinkingMode: "disabled" });
    await agent.chatAnthropic("Normal");

    expect(capturedParams.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(capturedParams.thinking).toBeUndefined();
  });

  test("strips thinking blocks from completed turns (no tool_use)", async () => {
    const msg = makeMessage({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "internal reasoning" } as any,
        { type: "text", text: "Final answer" },
      ],
    });
    const client = mockClient(() => fakeStream(msg));

    const agent = new Agent({ client, thinkingMode: "enabled" });
    const result = await agent.chatAnthropic("Think");

    // Thinking blocks should be stripped from the response
    const thinkingBlocks = result.response.content.filter(
      (b: any) => b.type === "thinking",
    );
    expect(thinkingBlocks).toHaveLength(0);

    // Text block should remain
    const textBlocks = result.response.content.filter(
      (b: any) => b.type === "text",
    );
    expect(textBlocks).toHaveLength(1);
  });

  test("preserves thinking blocks on tool_use turns", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "internal reasoning" } as any,
        { type: "text", text: "Let me use a tool" },
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callCount = 0;
    const client = mockClient(() => {
      callCount++;
      return fakeStream(callCount === 1 ? toolMsg : endMsg);
    });

    const agent = new Agent({
      client,
      thinkingMode: "enabled",
      executeTool: async () => "file content",
    });
    const result = await agent.chatAnthropic("Read a file");

    // The assistant message from the tool_use turn should keep thinking blocks
    const assistantMsg = result.messages.find(
      (m) => m.role === "assistant" && Array.isArray(m.content),
    );
    expect(assistantMsg).toBeDefined();
    const thinkingBlocks = (assistantMsg!.content as any[]).filter(
      (b: any) => b.type === "thinking",
    );
    expect(thinkingBlocks).toHaveLength(1);
  });

  test("default thinkingMode is disabled", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: Record<string, unknown> = {};
    const client = mockClient((params: Record<string, unknown>) => {
      capturedParams = params;
      return fakeStream(msg);
    });

    const agent = new Agent({ client });
    await agent.chatAnthropic("Hello");

    expect(capturedParams.thinking).toBeUndefined();
    expect(capturedParams.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// 10. getMessages — read-only snapshot
// ---------------------------------------------------------------------------

describe("getMessages", () => {
  test("returns message history after a turn", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const client = mockClient(() => fakeStream(msg));

    const agent = new Agent({ client });
    await agent.chatAnthropic("Test");

    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "Test" });
  });
});
