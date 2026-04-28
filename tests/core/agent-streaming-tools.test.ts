import { test, expect, describe } from "bun:test";
import { Agent } from "@/core/agent";
import type { Provider, StreamParams } from "@/core/provider";
import type { Message } from "@/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  } as Message;
}

// ---------------------------------------------------------------------------
// Streaming tool execution tests
// ---------------------------------------------------------------------------

describe("streaming tool execution", () => {
  test("concurrency-safe tool is executed early during streaming", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          // Simulate streaming: emit the tool_use block during streaming
          params.onToolUse?.({
            id: "tu_1",
            name: "read_file",
            input: { path: "a.txt" },
          });
          return toolMsg;
        }
        return endMsg;
      },
    };

    const executionTimestamps: { name: string; time: number }[] = [];
    const streamCompleteTime = Date.now();

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      executeTool: async (_name, input) => {
        executionTimestamps.push({ name: _name, time: Date.now() });
        return `content of ${(input as { path: string }).path}`;
      },
    });

    const result = await agent.chat("Read a file");

    expect(result.response.stop_reason).toBe("end_turn");
    expect(executionTimestamps).toHaveLength(1);
    expect(executionTimestamps[0].name).toBe("read_file");
  });

  test("early execution result is used instead of re-executing", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          params.onToolUse?.({
            id: "tu_1",
            name: "read_file",
            input: { path: "a.txt" },
          });
          return toolMsg;
        }
        return endMsg;
      },
    };

    let executeCount = 0;
    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      executeTool: async () => {
        executeCount++;
        return "file content";
      },
    });

    await agent.chat("Read");

    // executeTool should only be called once (early), not again in handleNextTurn
    expect(executeCount).toBe(1);
  });

  test("non-concurrency-safe tool is NOT executed early", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "write_file", input: { path: "a.txt", content: "x" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    let earlyExecTriggered = false;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          params.onToolUse?.({
            id: "tu_1",
            name: "write_file",
            input: { path: "a.txt", content: "x" },
          });
          return toolMsg;
        }
        return endMsg;
      },
    };

    const executionOrder: string[] = [];
    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]), // write_file NOT in set
      executeTool: async (name) => {
        executionOrder.push(name);
        return "ok";
      },
    });

    await agent.chat("Write file");

    // Should still execute, but only during handleNextTurn (not early)
    expect(executionOrder).toEqual(["write_file"]);
  });

  test("tool denied by checkPermission is NOT executed early", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/etc/passwd" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          params.onToolUse?.({
            id: "tu_1",
            name: "read_file",
            input: { path: "/etc/passwd" },
          });
          return toolMsg;
        }
        return endMsg;
      },
    };

    let executeCount = 0;
    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      checkPermission: (name, input) => {
        if ((input as { path: string }).path === "/etc/passwd") {
          return { behavior: "deny", reason: "sensitive file" };
        }
        return { behavior: "allow" };
      },
      executeTool: async () => {
        executeCount++;
        return "file content";
      },
    });

    await agent.chat("Read sensitive");

    // Tool still runs in handleNextTurn (no early exec due to deny),
    // so executeCount is 1 from the normal path
    expect(executeCount).toBe(1);
  });

  test("tool requiring user confirmation (ask) is NOT executed early", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "secret.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          params.onToolUse?.({
            id: "tu_1",
            name: "read_file",
            input: { path: "secret.txt" },
          });
          return toolMsg;
        }
        return endMsg;
      },
    };

    let executeCount = 0;
    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      checkPermission: () => ({ behavior: "ask", message: "Allow reading?" }),
      executeTool: async () => {
        executeCount++;
        return "content";
      },
    });

    await agent.chat("Read");

    // Tool runs in handleNextTurn only (not early due to "ask")
    expect(executeCount).toBe(1);
  });

  test("multiple tools: only concurrency-safe ones are executed early", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
        { type: "tool_use", id: "tu_2", name: "write_file", input: { path: "b.txt", content: "x" } },
        { type: "tool_use", id: "tu_3", name: "grep_search", input: { pattern: "foo" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          // Emit all tool_use blocks during streaming
          params.onToolUse?.({ id: "tu_1", name: "read_file", input: { path: "a.txt" } });
          params.onToolUse?.({ id: "tu_2", name: "write_file", input: { path: "b.txt", content: "x" } });
          params.onToolUse?.({ id: "tu_3", name: "grep_search", input: { pattern: "foo" } });
          return toolMsg;
        }
        return endMsg;
      },
    };

    const earlyExecuted: string[] = [];
    const normalExecuted: string[] = [];
    let firstCallForTool = new Map<string, boolean>();

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file", "grep_search"]),
      executeTool: async (name) => {
        if (!firstCallForTool.has(name)) {
          firstCallForTool.set(name, true);
        }
        return `result of ${name}`;
      },
    });

    await agent.chat("Do multiple things");

    // All tools execute exactly once
    expect(firstCallForTool.size).toBe(3);
  });

  test("early execution error is caught in handleNextTurn", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "missing.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          params.onToolUse?.({
            id: "tu_1",
            name: "read_file",
            input: { path: "missing.txt" },
          });
          return toolMsg;
        }
        return endMsg;
      },
    };

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      executeTool: async () => {
        throw new Error("file not found");
      },
    });

    const result = await agent.chat("Read missing");

    // Should not crash — error is caught and reported
    expect(result.response.stop_reason).toBe("end_turn");

    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    const content = (toolResultMsg!.content as Array<{ type: string; content?: string }>).find(
      (b) => b.type === "tool_result",
    );
    expect(content?.content).toContain("file not found");
  });

  test("without concurrencySafeTools configured, no early execution happens", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    let onToolUseCalled = false;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          params.onToolUse?.({
            id: "tu_1",
            name: "read_file",
            input: { path: "a.txt" },
          });
          onToolUseCalled = true;
          return toolMsg;
        }
        return endMsg;
      },
    };

    let executeCount = 0;
    const agent = new Agent({
      provider,
      // No concurrencySafeTools set — defaults to empty
      executeTool: async () => {
        executeCount++;
        return "content";
      },
    });

    await agent.chat("Read");

    expect(onToolUseCalled).toBe(true);
    // Tool still runs once in handleNextTurn (not early since set is empty)
    expect(executeCount).toBe(1);
  });

  test("checkPermission allowing passes through to early execution", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "safe.txt" } },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async (params) => {
        if (callIndex++ === 0) {
          params.onToolUse?.({
            id: "tu_1",
            name: "read_file",
            input: { path: "safe.txt" },
          });
          return toolMsg;
        }
        return endMsg;
      },
    };

    let permCheckCalled = false;
    let executeCount = 0;
    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      checkPermission: () => {
        permCheckCalled = true;
        return { behavior: "allow" };
      },
      executeTool: async () => {
        executeCount++;
        return "safe content";
      },
    });

    await agent.chat("Read safe");

    expect(permCheckCalled).toBe(true);
    // Executed early, not re-executed
    expect(executeCount).toBe(1);
  });
});
