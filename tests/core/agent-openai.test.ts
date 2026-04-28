import { test, expect, describe } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { Agent } from "@/core/agent";

// ---------------------------------------------------------------------------
// Helpers — mock OpenAI client with controllable streaming responses
// ---------------------------------------------------------------------------

interface MockChunk {
  choices: Array<{
    delta: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Create a mock OpenAI client that yields the given chunks from streaming.
 */
function mockOpenAIClient(chunkSets: MockChunk[][]): OpenAI {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const chunks = chunkSets[callIndex] ?? chunkSets[chunkSets.length - 1];
          callIndex++;
          return {
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                async next() {
                  if (i < chunks.length) return { value: chunks[i++], done: false };
                  return { value: undefined, done: true };
                },
              };
            },
          };
        },
      },
    },
  } as unknown as OpenAI;
}

/** Minimal Anthropic client (unused when openaiClient is set, but required by type). */
function dummyAnthropicClient(): Anthropic {
  return {} as unknown as Anthropic;
}

/** Build chunks for a simple text completion. */
function textChunks(text: string): MockChunk[] {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null }], usage: undefined },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
}

/** Build chunks for a tool call response. */
function toolCallChunks(toolCalls: Array<{ id: string; name: string; arguments: string }>): MockChunk[] {
  const chunks: MockChunk[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    // First chunk: id + name
    chunks.push({
      choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, function: { name: tc.name, arguments: "" } }] }, finish_reason: null }],
      usage: undefined,
    });
    // Second chunk: arguments
    chunks.push({
      choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: tc.arguments } }] }, finish_reason: null }],
      usage: undefined,
    });
  }
  // Final chunk: finish_reason
  chunks.push({
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  });
  return chunks;
}

// ---------------------------------------------------------------------------
// 1. Basic OpenAI streaming — text completion
// ---------------------------------------------------------------------------

describe("chatOpenAI - text completion", () => {
  test("routes to OpenAI path when openaiClient is set", async () => {
    const openaiClient = mockOpenAIClient([textChunks("Hello!")]);
    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
    });

    await agent.chat("Hi");
    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "Hi" });
  });

  test("onText receives streamed text deltas", async () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { content: "Hel" }, finish_reason: null }], usage: undefined },
      { choices: [{ delta: { content: "lo" }, finish_reason: null }], usage: undefined },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ];
    const openaiClient = mockOpenAIClient([chunks]);

    const deltas: string[] = [];
    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      onText: (d) => deltas.push(d),
    });

    await agent.chat("Hi");
    // First delta is "\n" (the leading newline), then content
    expect(deltas).toEqual(["\n", "Hel", "lo"]);
  });

  test("returns QueryResult with assembled response", async () => {
    const openaiClient = mockOpenAIClient([textChunks("Response text")]);
    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
    });

    const result = await agent.chatOpenAI("Test");
    expect(result.response.stop_reason).toBe("end_turn");
    expect(result.response.content).toEqual([{ type: "text", text: "Response text" }]);
    expect(result.response.usage.input_tokens).toBe(10);
    expect(result.response.usage.output_tokens).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. Tool call handling
// ---------------------------------------------------------------------------

describe("chatOpenAI - tool calls", () => {
  test("executes tools and continues until text completion", async () => {
    const toolChks = toolCallChunks([
      { id: "call_1", name: "read_file", arguments: '{"file_path":"a.txt"}' },
    ]);
    const endChks = textChunks("Done reading");

    const openaiClient = mockOpenAIClient([toolChks, endChks]);
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];

    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      executeTool: async (name, input) => {
        executed.push({ name, input });
        return "file content here";
      },
    });

    const result = await agent.chatOpenAI("Read a.txt");

    expect(executed).toHaveLength(1);
    expect(executed[0].name).toBe("read_file");
    expect(executed[0].input).toEqual({ file_path: "a.txt" });
    expect(result.response.stop_reason).toBe("end_turn");
  });

  test("handles multiple tool calls in a single response", async () => {
    const toolChks = toolCallChunks([
      { id: "call_1", name: "read_file", arguments: '{"file_path":"a.txt"}' },
      { id: "call_2", name: "read_file", arguments: '{"file_path":"b.txt"}' },
    ]);
    const endChks = textChunks("Both files read");

    const openaiClient = mockOpenAIClient([toolChks, endChks]);
    const executedNames: string[] = [];

    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      executeTool: async (name, input) => {
        executedNames.push((input as any).file_path);
        return "content";
      },
    });

    await agent.chatOpenAI("Read both");
    expect(executedNames).toEqual(["a.txt", "b.txt"]);
  });

  test("tool execution errors are caught and reported", async () => {
    const toolChks = toolCallChunks([
      { id: "call_1", name: "bad_tool", arguments: '{}' },
    ]);
    const endChks = textChunks("Handled error");

    const openaiClient = mockOpenAIClient([toolChks, endChks]);

    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      executeTool: async () => {
        throw new Error("tool exploded");
      },
    });

    const result = await agent.chatOpenAI("Try bad tool");
    // Should complete without throwing
    expect(result.response.stop_reason).toBe("end_turn");

    // The tool result should contain the error message
    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(toolResultMsg).toBeDefined();
    const content = (toolResultMsg!.content as Array<{ type: string; content?: string }>).find(
      (b) => b.type === "tool_result",
    );
    expect(content?.content).toContain("tool exploded");
  });

  test("onToolCall and onToolResult callbacks are fired", async () => {
    const toolChks = toolCallChunks([
      { id: "call_1", name: "read_file", arguments: '{"file_path":"test.ts"}' },
    ]);
    const endChks = textChunks("Done");

    const openaiClient = mockOpenAIClient([toolChks, endChks]);
    const toolCallEvents: Array<{ name: string; input: Record<string, unknown> }> = [];
    const toolResultEvents: Array<{ name: string; result: string }> = [];

    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      executeTool: async () => "result data",
      onToolCall: (name, input) => toolCallEvents.push({ name, input }),
      onToolResult: (name, result) => toolResultEvents.push({ name, result }),
    });

    await agent.chatOpenAI("Read test.ts");

    expect(toolCallEvents).toEqual([{ name: "read_file", input: { file_path: "test.ts" } }]);
    expect(toolResultEvents).toEqual([{ name: "read_file", result: "result data" }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Stop hook with OpenAI path
// ---------------------------------------------------------------------------

describe("chatOpenAI - stop hook", () => {
  test("checkStopHook blocking injects continue signal", async () => {
    const endChks = textChunks("Answer");
    const openaiClient = mockOpenAIClient([endChks, endChks]);

    let hookCalls = 0;
    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      checkStopHook: async () => {
        hookCalls++;
        return hookCalls === 1; // block first, allow second
      },
    });

    const result = await agent.chatOpenAI("Do task");

    expect(hookCalls).toBe(2);
    const hasContinuation = result.messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("not yet complete"),
    );
    expect(hasContinuation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Tool call delta accumulation (fragmented arguments)
// ---------------------------------------------------------------------------

describe("chatOpenAI - delta accumulation", () => {
  test("accumulates fragmented tool call arguments", async () => {
    // Simulate arguments arriving in multiple chunks
    const chunks: MockChunk[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "edit_file", arguments: '{"file' } }] }, finish_reason: null }], usage: undefined },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"x.ts"' } }] }, finish_reason: null }], usage: undefined },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ',"old_string":"a","new_string":"b"}' } }] }, finish_reason: null }], usage: undefined },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 15, completion_tokens: 8 } },
    ];
    const endChks = textChunks("Edited");

    const openaiClient = mockOpenAIClient([chunks, endChks]);
    let capturedInput: Record<string, unknown> = {};

    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      executeTool: async (_name, input) => {
        capturedInput = input;
        return "ok";
      },
    });

    await agent.chatOpenAI("Edit file");

    expect(capturedInput).toEqual({
      file_path: "x.ts",
      old_string: "a",
      new_string: "b",
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Message history format — stored in Anthropic format
// ---------------------------------------------------------------------------

describe("chatOpenAI - message history", () => {
  test("stores messages in Anthropic format after tool use turn", async () => {
    const toolChks = toolCallChunks([
      { id: "call_1", name: "read_file", arguments: '{"file_path":"a.txt"}' },
    ]);
    const endChks = textChunks("Here is the content");

    const openaiClient = mockOpenAIClient([toolChks, endChks]);
    const agent = new Agent({
      client: dummyAnthropicClient(),
      openaiClient,
      executeTool: async () => "file data",
    });

    await agent.chatOpenAI("Read a.txt");
    const msgs = agent.getMessages();

    // user → assistant (tool_use) → user (tool_result) → ...
    expect(msgs[0]).toEqual({ role: "user", content: "Read a.txt" });
    expect(msgs[1].role).toBe("assistant");
    const assistantContent = msgs[1].content as any[];
    expect(assistantContent.some((b: any) => b.type === "tool_use" && b.name === "read_file")).toBe(true);
    expect(msgs[2].role).toBe("user");
    const toolResults = msgs[2].content as any[];
    expect(toolResults[0].type).toBe("tool_result");
    expect(toolResults[0].tool_use_id).toBe("call_1");
    expect(toolResults[0].content).toBe("file data");
  });
});
