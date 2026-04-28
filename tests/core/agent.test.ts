import { test, expect, describe } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "@/core/agent";
import type { Provider, StreamParams } from "@/core/provider";
import {
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  THINKING_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
  MAX_COMPACT_RETRIES,
  type Message,
} from "@/core/types";

// ---------------------------------------------------------------------------
// Helpers — mock Provider with controllable responses
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

/**
 * Create a mock Provider. `createFn` receives StreamParams and returns the
 * Message to resolve. It can also fire onText deltas via params.onText.
 */
function mockProvider(
  createFn: (params: StreamParams) => Message | Promise<Message>,
): Provider {
  return {
    createMessage: async (params) => createFn(params),
  };
}

/**
 * Create a mock Provider that returns a sequence of messages, one per call.
 * Optionally captures params for assertion.
 */
function sequenceProvider(
  messages: Message[],
  captured?: { params: StreamParams[] },
): Provider {
  let callIndex = 0;
  return {
    createMessage: async (params) => {
      captured?.params.push(params);
      const msg = messages[callIndex] ?? messages[messages.length - 1];
      callIndex++;
      return msg;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Core agent loop — end_turn completion
// ---------------------------------------------------------------------------

describe("core loop", () => {
  test("end_turn returns response and appends user message to history", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const provider = sequenceProvider([msg]);

    const agent = new Agent({ provider });
    const result = await agent.chat("Hi");

    expect(result.response).toBe(msg);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: "user", content: "Hi" });
  });

  test("stop_sequence is treated like end_turn", async () => {
    const msg = makeMessage({ stop_reason: "stop_sequence" });
    const provider = sequenceProvider([msg]);

    const agent = new Agent({ provider });
    const result = await agent.chat("Hey");

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
    const provider = sequenceProvider([toolMsg, endMsg]);

    const executionOrder: string[] = [];
    const agent = new Agent({
      provider,
      executeTool: async (_name, input) => {
        executionOrder.push((input as { path: string }).path);
        return `content of ${(input as { path: string }).path}`;
      },
    });

    const result = await agent.chat("Read files");

    expect(executionOrder).toEqual(["a.txt", "b.txt"]);
    expect(result.response.stop_reason).toBe("end_turn");
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
    const provider = sequenceProvider([toolMsg, endMsg]);

    const agent = new Agent({
      provider,
      executeTool: async () => {
        throw new Error("tool broke");
      },
    });

    const result = await agent.chat("Do thing");
    expect(result.response.stop_reason).toBe("end_turn");

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
    const provider = sequenceProvider([toolMsg, endMsg]);

    const agent = new Agent({ provider });
    const result = await agent.chat("Do thing");

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

    const captured: { params: StreamParams[] } = { params: [] };
    const provider = sequenceProvider([truncMsg, endMsg], captured);

    const agent = new Agent({ provider });
    await agent.chat("Write essay");

    expect(captured.params[0].maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(captured.params[1].maxTokens).toBe(ESCALATED_MAX_TOKENS);
  });

  test("after escalation, uses recovery retries up to MAX_RECOVERY_RETRIES then returns", async () => {
    const truncMsg = makeMessage({ stop_reason: "max_tokens" });

    const captured: { params: StreamParams[] } = { params: [] };
    const provider = sequenceProvider([truncMsg], captured);

    const agent = new Agent({ provider });
    const result = await agent.chat("Very long essay");

    // 1 initial + 1 escalation + MAX_RECOVERY_RETRIES = total calls
    expect(captured.params.length).toBe(2 + MAX_RECOVERY_RETRIES);
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
    const provider = sequenceProvider([pauseMsg, endMsg]);

    const agent = new Agent({ provider });
    const result = await agent.chat("Continue");

    expect(result.response.stop_reason).toBe("end_turn");

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
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount === 1) throw ptlError;
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    const agent = new Agent({
      provider,
      collapseContext: async (msgs) => {
        collapseCount++;
        return msgs;
      },
    });

    await agent.chat("Big message");
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
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount <= 2) throw ptlError;
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    const agent = new Agent({
      provider,
      compactMessages: async (msgs) => {
        compactCount++;
        return msgs;
      },
    });

    await agent.chat("Big message");
    expect(compactCount).toBe(1);
  });

  test("exhausting all PTL retries throws the withheld error", async () => {
    const ptlError = new Anthropic.BadRequestError(
      "prompt is too long",
      { status: 400, headers: {} as any, error: undefined, request: {} as any, body: undefined },
      undefined as any,
    );

    const provider: Provider = {
      createMessage: async () => { throw ptlError; },
    };

    const agent = new Agent({ provider });
    await expect(agent.chat("Huge")).rejects.toThrow("prompt is too long");
  });

  test("non-PTL errors propagate immediately", async () => {
    const provider: Provider = {
      createMessage: async () => { throw new Error("network failure"); },
    };

    const agent = new Agent({ provider });
    await expect(agent.chat("Msg")).rejects.toThrow("network failure");
  });
});

// ---------------------------------------------------------------------------
// 6. Streaming — onText callback
// ---------------------------------------------------------------------------

describe("streaming", () => {
  test("onText receives text deltas from provider", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const provider = mockProvider((params) => {
      // Simulate text deltas
      params.onText?.("Hel");
      params.onText?.("lo");
      params.onText?.(" world");
      return msg;
    });

    const deltas: string[] = [];
    const agent = new Agent({
      provider,
      onText: (d) => deltas.push(d),
    });

    await agent.chat("Hi");
    expect(deltas).toEqual(["Hel", "lo", " world"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Stop hook
// ---------------------------------------------------------------------------

describe("stop hook", () => {
  test("checkStopHook blocking injects continue signal and retries", async () => {
    const endMsg = makeMessage({ stop_reason: "end_turn" });
    const provider = sequenceProvider([endMsg, endMsg]);

    let hookCalls = 0;
    const agent = new Agent({
      provider,
      checkStopHook: async () => {
        hookCalls++;
        return hookCalls === 1; // block first time, allow second
      },
    });

    const result = await agent.chat("Do task");

    expect(hookCalls).toBe(2);

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
  test("chat() passes abort signal to provider", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedSignal: AbortSignal | undefined;

    const provider = mockProvider((params) => {
      capturedSignal = params.signal;
      return msg;
    });

    const agent = new Agent({ provider });
    await agent.chat("Hello");

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
  });

  test("abort() aborts the in-flight signal", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedSignal: AbortSignal | undefined;
    let resolveMessage: (() => void) | null = null;

    const provider: Provider = {
      createMessage: async (params) => {
        capturedSignal = params.signal;
        return new Promise<Message>((resolve) => {
          resolveMessage = () => resolve(msg);
        });
      },
    };

    const agent = new Agent({ provider });
    const chatPromise = agent.chat("Hello");

    // Abort while streaming
    agent.abort();
    expect(capturedSignal!.aborted).toBe(true);

    // Resolve to let chat() finish
    resolveMessage!();
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
    const provider = sequenceProvider([toolMsg, endMsg]);

    const executed: string[] = [];
    const agent = new Agent({
      provider,
      executeTool: async (name) => {
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
// 9. Thinking mode — params are forwarded to provider
// ---------------------------------------------------------------------------

describe("thinking mode", () => {
  test("enabled mode forwards thinkingMode to provider", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: StreamParams | undefined;
    const provider = mockProvider((params) => {
      capturedParams = params;
      return msg;
    });

    const agent = new Agent({ provider, thinkingMode: "enabled" });
    await agent.chat("Think hard");

    expect(capturedParams!.thinkingMode).toBe("enabled");
  });

  test("adaptive mode forwards thinkingMode to provider", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: StreamParams | undefined;
    const provider = mockProvider((params) => {
      capturedParams = params;
      return msg;
    });

    const agent = new Agent({ provider, thinkingMode: "adaptive" });
    await agent.chat("Think a bit");

    expect(capturedParams!.thinkingMode).toBe("adaptive");
  });

  test("default thinkingMode is disabled", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: StreamParams | undefined;
    const provider = mockProvider((params) => {
      capturedParams = params;
      return msg;
    });

    const agent = new Agent({ provider });
    await agent.chat("Hello");

    expect(capturedParams!.thinkingMode).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// 10. getMessages — read-only snapshot
// ---------------------------------------------------------------------------

describe("getMessages", () => {
  test("returns message history after a turn", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const provider = sequenceProvider([msg]);

    const agent = new Agent({ provider });
    await agent.chat("Test");

    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "Test" });
  });
});
