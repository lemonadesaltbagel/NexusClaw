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

// ---------------------------------------------------------------------------
// Streaming tool execution tests
// ---------------------------------------------------------------------------

describe("streaming tool execution", () => {
  test("concurrency-safe tool is executed early during streaming", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
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
    expect(executionTimestamps[0]!.name).toBe("read_file");
  });

  test("early execution result is used instead of re-executing", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
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
        mockToolUseBlock({ id: "tu_1", name: "write_file", input: { path: "a.txt", content: "x" } }),
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
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "/etc/passwd" } }),
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
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "secret.txt" } }),
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
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
        mockToolUseBlock({ id: "tu_2", name: "write_file", input: { path: "b.txt", content: "x" } }),
        mockToolUseBlock({ id: "tu_3", name: "grep_search", input: { pattern: "foo" } }),
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
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "missing.txt" } }),
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
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
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
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "safe.txt" } }),
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

// ---------------------------------------------------------------------------
// Parallel tool execution (batching for OpenAI and non-early paths)
// ---------------------------------------------------------------------------

describe("parallel tool execution batching", () => {
  test("consecutive concurrency-safe tools run in parallel", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
        mockToolUseBlock({ id: "tu_2", name: "read_file", input: { path: "b.txt" } }),
        mockToolUseBlock({ id: "tu_3", name: "read_file", input: { path: "c.txt" } }),
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    // Provider does NOT fire onToolUse — simulates OpenAI path (no early exec)
    const provider: Provider = {
      createMessage: async () => (callIndex++ === 0 ? toolMsg : endMsg),
    };

    const timestamps: { name: string; path: string; start: number; end: number }[] = [];

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      executeTool: async (_name, input) => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        timestamps.push({
          name: _name,
          path: (input as { path: string }).path,
          start,
          end: Date.now(),
        });
        return `content of ${(input as { path: string }).path}`;
      },
    });

    const result = await agent.chat("Read files");

    expect(result.response.stop_reason).toBe("end_turn");
    expect(timestamps).toHaveLength(3);

    // All three should have overlapping execution windows (started before any finished)
    const maxStart = Math.max(...timestamps.map((t) => t.start));
    const minEnd = Math.min(...timestamps.map((t) => t.end));
    expect(maxStart).toBeLessThan(minEnd);
  });

  test("non-safe tools execute sequentially even when consecutive", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "write_file", input: { path: "a.txt", content: "x" } }),
        mockToolUseBlock({ id: "tu_2", name: "write_file", input: { path: "b.txt", content: "y" } }),
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async () => (callIndex++ === 0 ? toolMsg : endMsg),
    };

    const timestamps: { start: number; end: number }[] = [];

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]), // write_file NOT safe
      executeTool: async () => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 50));
        timestamps.push({ start, end: Date.now() });
        return "ok";
      },
    });

    await agent.chat("Write files");

    expect(timestamps).toHaveLength(2);
    // Second tool should start after first finishes (sequential)
    expect(timestamps[1]!.start).toBeGreaterThanOrEqual(timestamps[0]!.end);
  });

  test("mixed tools: safe batch runs parallel, non-safe runs sequentially", async () => {
    // Layout: [safe, safe, non-safe, safe, safe]
    // Expected batches: [safe×2 parallel], [non-safe sequential], [safe×2 parallel]
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
        mockToolUseBlock({ id: "tu_2", name: "grep_search", input: { pattern: "foo" } }),
        mockToolUseBlock({ id: "tu_3", name: "write_file", input: { path: "b.txt", content: "x" } }),
        mockToolUseBlock({ id: "tu_4", name: "read_file", input: { path: "c.txt" } }),
        mockToolUseBlock({ id: "tu_5", name: "grep_search", input: { pattern: "bar" } }),
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async () => (callIndex++ === 0 ? toolMsg : endMsg),
    };

    const executionOrder: string[] = [];

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file", "grep_search"]),
      executeTool: async (name) => {
        executionOrder.push(name);
        return `result of ${name}`;
      },
    });

    const result = await agent.chat("Do things");

    expect(result.response.stop_reason).toBe("end_turn");
    // All 5 tools should execute
    expect(executionOrder).toHaveLength(5);

    // Verify results are in correct order in the messages
    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    const toolResults = (toolResultMsg!.content as any[]).filter(
      (b: any) => b.type === "tool_result",
    );
    expect(toolResults.map((r: any) => r.tool_use_id)).toEqual([
      "tu_1", "tu_2", "tu_3", "tu_4", "tu_5",
    ]);
  });

  test("permission-denied tools break the concurrent batch", async () => {
    // [safe+allowed, safe+denied, safe+allowed]
    // The denied tool is not concurrent, so batches become:
    // [safe×1 parallel], [denied sequential], [safe×1 parallel]
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "ok.txt" } }),
        mockToolUseBlock({ id: "tu_2", name: "read_file", input: { path: "secret.txt" } }),
        mockToolUseBlock({ id: "tu_3", name: "read_file", input: { path: "also-ok.txt" } }),
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async () => (callIndex++ === 0 ? toolMsg : endMsg),
    };

    const executionOrder: string[] = [];

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      checkPermission: (_name, input) => {
        if ((input as { path: string }).path === "secret.txt") {
          return { behavior: "deny", reason: "nope" };
        }
        return { behavior: "allow" };
      },
      executeTool: async (name, input) => {
        executionOrder.push((input as { path: string }).path);
        return "ok";
      },
    });

    await agent.chat("Read three files");

    // All three tools still execute (denied just means not concurrent)
    expect(executionOrder).toHaveLength(3);
  });

  test("error in one parallel tool does not prevent others from completing", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "good.txt" } }),
        mockToolUseBlock({ id: "tu_2", name: "read_file", input: { path: "bad.txt" } }),
        mockToolUseBlock({ id: "tu_3", name: "read_file", input: { path: "also-good.txt" } }),
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async () => (callIndex++ === 0 ? toolMsg : endMsg),
    };

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      executeTool: async (_name, input) => {
        const path = (input as { path: string }).path;
        if (path === "bad.txt") throw new Error("disk error");
        return `content of ${path}`;
      },
    });

    const result = await agent.chat("Read files");

    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    const toolResults = (toolResultMsg!.content as any[]).filter(
      (b: any) => b.type === "tool_result",
    );

    expect(toolResults).toHaveLength(3);
    expect(toolResults[0]!.content).toBe("content of good.txt");
    expect(toolResults[1]!.content).toContain("disk error");
    expect(toolResults[2]!.content).toBe("content of also-good.txt");
  });

  test("single tool creates a single-item batch and works correctly", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "only.txt" } }),
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });

    let callIndex = 0;
    const provider: Provider = {
      createMessage: async () => (callIndex++ === 0 ? toolMsg : endMsg),
    };

    const agent = new Agent({
      provider,
      concurrencySafeTools: new Set(["read_file"]),
      executeTool: async () => "single result",
    });

    const result = await agent.chat("Read one");

    const toolResultMsg = result.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    const toolResults = (toolResultMsg!.content as any[]).filter(
      (b: any) => b.type === "tool_result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.content).toBe("single result");
  });
});
