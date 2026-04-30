import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Agent } from "@/core/agent";
import type { Provider, StreamParams } from "@/core/provider";
import type { Message } from "@/core/types";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  };
}

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

/** Build a tool_use + tool_result round-trip in messages. */
function makeToolRound(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  toolUseId: string,
): [
  { role: "assistant"; content: any[] },
  { role: "user"; content: any[] },
] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolUseId, name: toolName, input },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: result },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// 1. persistLargeResult — saves >30KB results to disk
// ---------------------------------------------------------------------------

describe("persistLargeResult", () => {
  const toolResultsDir = join(homedir(), ".mini-claude", "tool-results");

  // Track files created during tests for cleanup
  let filesBefore: Set<string>;
  beforeEach(() => {
    filesBefore = new Set(
      existsSync(toolResultsDir) ? readdirSync(toolResultsDir) : [],
    );
  });
  afterEach(() => {
    if (!existsSync(toolResultsDir)) return;
    for (const f of readdirSync(toolResultsDir)) {
      if (!filesBefore.has(f)) {
        try { rmSync(join(toolResultsDir, f)); } catch {}
      }
    }
  });

  test("small results pass through unchanged", async () => {
    const smallResult = "x".repeat(1000);
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: {} },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });
    const provider = sequenceProvider([toolMsg, endMsg]);

    let capturedResult = "";
    const agent = new Agent({
      provider,
      executeTool: async () => smallResult,
      onToolResult: (_name, result) => {
        capturedResult = result;
      },
    });

    await agent.chat("Read file");
    expect(capturedResult).toBe(smallResult);
  });

  test("large results (>30KB) are persisted to disk with preview", async () => {
    const largeResult = "line\n".repeat(10000); // ~50KB
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_1", name: "grep_search", input: {} },
      ],
    });
    const endMsg = makeMessage({ stop_reason: "end_turn" });
    const provider = sequenceProvider([toolMsg, endMsg]);

    let capturedResult = "";
    const agent = new Agent({
      provider,
      executeTool: async () => largeResult,
      onToolResult: (_name, result) => {
        capturedResult = result;
      },
    });

    await agent.chat("Search");

    expect(capturedResult).toContain("Result too large");
    expect(capturedResult).toContain("Preview (first 200 lines)");
    expect(capturedResult).toContain(toolResultsDir);

    // Verify file was created
    const newFiles = readdirSync(toolResultsDir).filter(
      (f) => !filesBefore.has(f),
    );
    expect(newFiles.length).toBe(1);
    expect(newFiles[0]).toContain("grep_search");
  });
});

// ---------------------------------------------------------------------------
// 2. budgetToolResults — trims tool_result strings under pressure
// ---------------------------------------------------------------------------

describe("budgetToolResults", () => {
  test("does not trim when utilization is below 50%", async () => {
    // Use content under 30KB persist threshold (30*1024=30720 bytes)
    const longContent = "x".repeat(20_000);

    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      usage: { input_tokens: 80_000, output_tokens: 5 }, // 40% of 200K
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { file_path: "a.ts" } },
      ],
    });
    const endMsg1 = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 80_000, output_tokens: 5 },
    });
    const endMsg2 = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 80_000, output_tokens: 5 },
    });
    const provider = sequenceProvider([toolMsg, endMsg1, endMsg2]);

    const agent = new Agent({
      provider,
      executeTool: async () => longContent,
    });

    await agent.chat("Read file");
    // Second turn triggers budgetToolResults with the tracked utilization
    await agent.chat("Continue");

    // Check tool result is NOT trimmed (40% < 50%)
    const msgs = agent.getMessages();
    const toolResultMsg = msgs.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    const block = (toolResultMsg?.content as any[])?.find(
      (b: any) => b.type === "tool_result",
    );
    expect(block?.content?.length).toBe(longContent.length);
  });

  test("trims to 15K budget when utilization exceeds 70%", async () => {
    // 25K chars < 30KB persist threshold, but > 15K budget
    const longContent = "x".repeat(25_000);

    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      usage: { input_tokens: 160_000, output_tokens: 5 }, // 80% of 200K
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { file_path: "a.ts" } },
      ],
    });
    const endMsg1 = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 160_000, output_tokens: 5 },
    });
    const endMsg2 = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 160_000, output_tokens: 5 },
    });
    const provider = sequenceProvider([toolMsg, endMsg1, endMsg2]);

    const agent = new Agent({
      provider,
      executeTool: async () => longContent,
    });

    await agent.chat("Read file");
    await agent.chat("Continue");

    const msgs = agent.getMessages();
    const toolResultMsg = msgs.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    const block = (toolResultMsg?.content as any[])?.find(
      (b: any) => b.type === "tool_result",
    );
    expect(block?.content?.length).toBeLessThanOrEqual(15_100);
    expect(block?.content).toContain("budgeted");
  });
});

// ---------------------------------------------------------------------------
// 3. snipStaleResults — snips redundant results at 60%+ utilization
// ---------------------------------------------------------------------------

describe("snipStaleResults", () => {
  test("snips duplicate read_file results, keeps only latest per file", async () => {
    // Need 5 tool results so the old dup falls outside the 3-most-recent protection.
    // Tool calls: read main.ts (v1), read a.ts, read b.ts, read main.ts (v2), read c.ts
    // Protected (last 3): tr_3(b.ts), tr_4(main v2), tr_5(c.ts)
    // tr_1(main v1): not protected, dup of main.ts → SNIPPED
    // tr_2(a.ts): not protected, unique → preserved
    const tools = [
      { id: "tu_1", name: "read_file", input: { file_path: "/src/main.ts" } },
      { id: "tu_2", name: "read_file", input: { file_path: "/src/a.ts" } },
      { id: "tu_3", name: "read_file", input: { file_path: "/src/b.ts" } },
      { id: "tu_4", name: "read_file", input: { file_path: "/src/main.ts" } },
      { id: "tu_5", name: "read_file", input: { file_path: "/src/c.ts" } },
    ];

    const toolMsgs = tools.map((t) =>
      makeMessage({
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 130_000, output_tokens: 5 }, // 65%
        content: [{ type: "tool_use", ...t }],
      }),
    );
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 130_000, output_tokens: 5 },
    });

    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount <= 5) return toolMsgs[callCount - 1];
        return endMsg;
      },
    };

    let readCount = 0;
    const agent = new Agent({
      provider,
      executeTool: async () => {
        readCount++;
        return `content_${readCount}`;
      },
    });

    await agent.chat("Read files");

    const msgs = agent.getMessages();
    const toolResults = msgs
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "tool_result"),
      );

    expect(toolResults.length).toBe(5);
    // tu_1: /src/main.ts v1 — dup, not in last 3 → SNIPPED
    expect(toolResults[0].content).toBe("[Content snipped - re-read if needed]");
    // tu_2: /src/a.ts — unique, not in last 3 but only read of a.ts → preserved
    expect(toolResults[1].content).toBe("content_2");
    // tu_3-5: in protected last 3 → preserved
    expect(toolResults[2].content).toBe("content_3");
    expect(toolResults[3].content).toBe("content_4");
    expect(toolResults[4].content).toBe("content_5");
  });

  test("snips oldest search results when >3 of same type", async () => {
    // Build 5 grep_search calls, expect oldest 2 to be snipped
    const toolMessages: Message[] = [];
    for (let i = 1; i <= 5; i++) {
      toolMessages.push(
        makeMessage({
          stop_reason: "tool_use",
          usage: { input_tokens: 130_000, output_tokens: 5 },
          content: [
            {
              type: "tool_use",
              id: `tu_${i}`,
              name: "grep_search",
              input: { pattern: `search_${i}` },
            },
          ],
        }),
      );
    }

    let callCount = 0;
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 130_000, output_tokens: 5 },
    });

    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount <= 5) return toolMessages[callCount - 1];
        return endMsg;
      },
    };

    let searchCount = 0;
    const agent = new Agent({
      provider,
      executeTool: async () => {
        searchCount++;
        return `grep result ${searchCount}`;
      },
    });

    await agent.chat("Search many times");

    const msgs = agent.getMessages();
    const toolResults = msgs
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "tool_result"),
      );

    expect(toolResults.length).toBe(5);
    // Oldest 2 should be snipped
    expect(toolResults[0].content).toBe("[Content snipped - re-read if needed]");
    expect(toolResults[1].content).toBe("[Content snipped - re-read if needed]");
    // Latest 3 preserved
    expect(toolResults[2].content).toBe("grep result 3");
    expect(toolResults[3].content).toBe("grep result 4");
    expect(toolResults[4].content).toBe("grep result 5");
  });

  test("always preserves the 3 most recent tool_result entries", async () => {
    // 4 read_file calls to different files — last 3 should be protected
    const toolMessages: Message[] = [];
    for (let i = 1; i <= 4; i++) {
      toolMessages.push(
        makeMessage({
          stop_reason: "tool_use",
          usage: { input_tokens: 130_000, output_tokens: 5 },
          content: [
            {
              type: "tool_use",
              id: `tu_${i}`,
              name: "read_file",
              input: { file_path: `/src/file${i}.ts` },
            },
          ],
        }),
      );
    }
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 130_000, output_tokens: 5 },
    });

    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount <= 4) return toolMessages[callCount - 1];
        return endMsg;
      },
    };

    let readCount = 0;
    const agent = new Agent({
      provider,
      executeTool: async () => {
        readCount++;
        return `content of file${readCount}`;
      },
    });

    await agent.chat("Read four different files");

    const msgs = agent.getMessages();
    const toolResults = msgs
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "tool_result"),
      );

    expect(toolResults.length).toBe(4);
    // All are different files — read_file dedup won't apply.
    // But the last 3 are protected, so only the first can potentially be snipped.
    // Since each file is unique (latest per path = itself), none should be snipped.
    expect(toolResults[0].content).toBe("content of file1");
    expect(toolResults[1].content).toBe("content of file2");
    expect(toolResults[2].content).toBe("content of file3");
    expect(toolResults[3].content).toBe("content of file4");
  });

  test("does not snip when utilization is below 60%", async () => {
    // Two reads of same file at low utilization — should NOT be snipped
    const readTool1 = makeMessage({
      stop_reason: "tool_use",
      usage: { input_tokens: 100_000, output_tokens: 5 }, // 50%
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { file_path: "/a.ts" } },
      ],
    });
    const readTool2 = makeMessage({
      stop_reason: "tool_use",
      usage: { input_tokens: 100_000, output_tokens: 5 },
      content: [
        { type: "tool_use", id: "tu_2", name: "read_file", input: { file_path: "/a.ts" } },
      ],
    });
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 100_000, output_tokens: 5 },
    });

    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount === 1) return readTool1;
        if (callCount === 2) return readTool2;
        return endMsg;
      },
    };

    let readCount = 0;
    const agent = new Agent({
      provider,
      executeTool: async () => {
        readCount++;
        return `v${readCount}`;
      },
    });

    await agent.chat("Read twice");

    const msgs = agent.getMessages();
    const toolResults = msgs
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "tool_result"),
      );

    // Neither should be snipped at 50% utilization
    expect(toolResults[0].content).toBe("v1");
    expect(toolResults[1].content).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// 4. microcompact — clears old results after idle period
// ---------------------------------------------------------------------------

describe("microcompact", () => {
  test("clears old tool results after idle period, preserves recent 3", async () => {
    // Build 5 tool rounds, then simulate idle gap via lastApiCallTime manipulation
    const toolMessages: Message[] = [];
    for (let i = 1; i <= 5; i++) {
      toolMessages.push(
        makeMessage({
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: "tool_use", id: `tu_${i}`, name: "read_file", input: { file_path: `f${i}.ts` } },
          ],
        }),
      );
    }
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount <= 5) return toolMessages[callCount - 1];
        return endMsg;
      },
    };

    let readCount = 0;
    const agent = new Agent({
      provider,
      executeTool: async () => {
        readCount++;
        return `result_${readCount}`;
      },
    });

    // First chat: 5 tool calls
    await agent.chat("Read five files");

    // Simulate idle: set lastApiCallTime to 6 minutes ago
    (agent as any).lastApiCallTime = Date.now() - 6 * 60 * 1000;

    // Second chat triggers microcompact before API call
    callCount = 6; // Skip to end_turn
    await agent.chat("Continue after idle");

    const msgs = agent.getMessages();
    const toolResults = msgs
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "tool_result"),
      );

    // 5 tool results from first chat
    // microcompact should clear all but the 3 most recent
    const cleared = toolResults.filter(
      (b: any) => b.content === "[Old result cleared]",
    );
    const preserved = toolResults.filter(
      (b: any) => b.content !== "[Old result cleared]",
    );

    expect(cleared.length).toBe(2);
    expect(preserved.length).toBeGreaterThanOrEqual(3);
  });

  test("does not clear results when not idle", async () => {
    const toolMsg = makeMessage({
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: "tool_use", id: "tu_1", name: "read_file", input: { file_path: "a.ts" } },
      ],
    });
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount === 1) return toolMsg;
        return endMsg;
      },
    };

    const agent = new Agent({
      provider,
      executeTool: async () => "file content",
    });

    await agent.chat("Read file");
    // Immediately chat again (no idle gap)
    callCount = 2;
    await agent.chat("Continue");

    const msgs = agent.getMessages();
    const toolResults = msgs
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "tool_result"),
      );

    expect(toolResults.every((b: any) => b.content !== "[Old result cleared]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. checkAndCompact / compactConversation — auto-compact at 85%
// ---------------------------------------------------------------------------

describe("auto-compact", () => {
  test("triggers compaction when utilization exceeds 85%", async () => {
    // Need >=4 messages before compaction fires. Strategy:
    // chat 1: tool_use → end_turn (low util) → builds up 3 messages
    // chat 2: end_turn (high util) → now 4 messages → compaction triggers

    let providerCallCount = 0;
    let summaryCallMessages: readonly any[] = [];

    const provider: Provider = {
      createMessage: async (params) => {
        providerCallCount++;
        if (providerCallCount === 1) {
          // Chat 1: tool_use
          return makeMessage({
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: "tool_use", id: "tu_1", name: "read_file", input: { file_path: "a.ts" } },
            ],
          });
        }
        if (providerCallCount === 2) {
          // Chat 1: end_turn after tool
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        if (providerCallCount === 3) {
          // Chat 2: end_turn with high utilization → triggers compact
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 180_000, output_tokens: 5 },
          });
        }
        if (providerCallCount === 4) {
          // Summary call from compactConversation
          summaryCallMessages = params.messages;
          return makeMessage({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Summary: we read a.ts." }],
            usage: { input_tokens: 1_000, output_tokens: 50 },
          });
        }
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 5_000, output_tokens: 5 },
        });
      },
    };

    const agent = new Agent({
      provider,
      executeTool: async () => "file content",
    });

    await agent.chat("Read file");
    // messages now: [user, assistant(tool_use), user(tool_result)] = 3
    await agent.chat("Continue working");
    // messages before API: [user, asst, user(tr), user("Continue")] = 4
    // API returns 180K util → checkAndCompact fires → compactConversation

    const msgs = agent.getMessages();

    const summaryUserMsg = msgs.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("Previous conversation summary"),
    );
    expect(summaryUserMsg).toBeDefined();

    // Summary call should have included a summarization prompt
    expect(summaryCallMessages.length).toBeGreaterThan(0);
    const lastSummaryMsg = summaryCallMessages[summaryCallMessages.length - 1] as any;
    expect(lastSummaryMsg.content).toContain("Summarize the conversation");
  });

  test("does not compact when utilization is below 85%", async () => {
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 100_000, output_tokens: 5 }, // 50%
    });
    const provider = sequenceProvider([endMsg, endMsg]);

    const agent = new Agent({ provider });

    await agent.chat("Hello");
    await agent.chat("World");

    const msgs = agent.getMessages();
    const userMsgs = msgs.filter(
      (m) => m.role === "user" && typeof m.content === "string",
    );
    expect(userMsgs.length).toBe(2);
    expect(
      msgs.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("Previous conversation summary"),
      ),
    ).toBe(false);
  });

  test("compaction resets lastInputTokenCount to 0", async () => {
    // Build up >=4 messages, trigger compaction, verify no re-trigger on next chat
    let providerCallCount = 0;

    const provider: Provider = {
      createMessage: async () => {
        providerCallCount++;
        if (providerCallCount === 1) {
          // Chat 1: tool_use (low util)
          return makeMessage({
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: "tool_use", id: "tu_1", name: "read_file", input: {} },
            ],
          });
        }
        if (providerCallCount === 2) {
          // Chat 1: end_turn (low util)
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        if (providerCallCount === 3) {
          // Chat 2: end_turn (high util → triggers compact)
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 180_000, output_tokens: 5 },
          });
        }
        if (providerCallCount === 4) {
          // Summary call
          return makeMessage({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Summary." }],
            usage: { input_tokens: 500, output_tokens: 20 },
          });
        }
        // Chat 3: should NOT trigger compaction (lastInputTokenCount was reset)
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 5_000, output_tokens: 5 },
        });
      },
    };

    const agent = new Agent({
      provider,
      executeTool: async () => "ok",
    });

    await agent.chat("First"); // tool round: calls 1-2
    await agent.chat("Second"); // high util: calls 3-4 (compact)
    await agent.chat("Third"); // low util: call 5, no extra summary call

    // 5 calls total: tool_use, end_turn, high-end_turn, summary, final-end_turn
    expect(providerCallCount).toBe(5);
  });

  test("skips compaction when history is too short (<4 messages)", async () => {
    let providerCallCount = 0;

    const provider: Provider = {
      createMessage: async () => {
        providerCallCount++;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 180_000, output_tokens: 5 },
        });
      },
    };

    const agent = new Agent({ provider });
    await agent.chat("Short conversation");

    // Only 1 user message → messages.length=1 < 4, compaction skipped
    // Should be exactly 1 provider call (no summary call)
    expect(providerCallCount).toBe(1);

    const msgs = agent.getMessages();
    expect(
      msgs.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("Previous conversation summary"),
      ),
    ).toBe(false);
  });

  test("OpenAI compaction uses summarizer system override and preserves original system", async () => {
    // Same structure as Anthropic test but with providerType: "openai"
    let providerCallCount = 0;
    let summaryCallSystem: any = undefined;

    const provider: Provider = {
      createMessage: async (params) => {
        providerCallCount++;
        if (providerCallCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: "tool_use", id: "tu_1", name: "read_file", input: { file_path: "a.ts" } },
            ],
          });
        }
        if (providerCallCount === 2) {
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        if (providerCallCount === 3) {
          // Chat 2: high util triggers compaction
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 180_000, output_tokens: 5 },
          });
        }
        if (providerCallCount === 4) {
          // Summary call — capture system override
          summaryCallSystem = params.system;
          return makeMessage({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Summary: read a.ts." }],
            usage: { input_tokens: 1_000, output_tokens: 50 },
          });
        }
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 5_000, output_tokens: 5 },
        });
      },
    };

    const agent = new Agent({
      provider,
      providerType: "openai",
      system: "You are a helpful coding assistant.",
      executeTool: async () => "file content",
    });

    await agent.chat("Read file");
    await agent.chat("Continue");

    // Summary call should use summarizer system override
    expect(summaryCallSystem).toBe(
      "You are a conversation summarizer. Be concise but preserve important details.",
    );

    // Messages should be compacted
    const msgs = agent.getMessages();
    const summaryUserMsg = msgs.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("Previous conversation summary"),
    );
    expect(summaryUserMsg).toBeDefined();

    // lastInputTokenCount reset — next chat should not re-trigger
    await agent.chat("Third message");
    expect(providerCallCount).toBe(5); // no extra summary call
  });
});

// ---------------------------------------------------------------------------
// 6. Manual compaction via agent.compact()
// ---------------------------------------------------------------------------

describe("manual compact", () => {
  test("compact() calls compactConversation and logs confirmation", async () => {
    // Build enough history (>=4 messages) so compaction actually fires
    let providerCallCount = 0;

    const provider: Provider = {
      createMessage: async () => {
        providerCallCount++;
        if (providerCallCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
            content: [
              { type: "tool_use", id: "tu_1", name: "read_file", input: {} },
            ],
          });
        }
        if (providerCallCount === 2) {
          return makeMessage({
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        // Summary call from compact()
        return makeMessage({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Summary of work so far." }],
          usage: { input_tokens: 500, output_tokens: 30 },
        });
      },
    };

    const agent = new Agent({
      provider,
      executeTool: async () => "ok",
    });

    await agent.chat("Do something");
    // messages: [user, assistant(tool_use), user(tool_result)] = 3

    // Add another user msg to reach >= 4
    await agent.chat("Another turn");
    // messages: [user, asst, user(tr), user("Another turn")] = 4

    const logSpy: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logSpy.push(args.join(" "));

    try {
      await agent.compact();
    } finally {
      console.log = origLog;
    }

    // Should have called provider for summary
    expect(providerCallCount).toBeGreaterThanOrEqual(3);

    // Should have logged confirmation
    expect(logSpy.some((l) => l.includes("Conversation compacted"))).toBe(true);

    // Messages should be compacted
    const msgs = agent.getMessages();
    const hasSummary = msgs.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("Previous conversation summary"),
    );
    expect(hasSummary).toBe(true);
  });

  test("compact() is a no-op when history is too short", async () => {
    let providerCallCount = 0;

    const provider: Provider = {
      createMessage: async () => {
        providerCallCount++;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    };

    const agent = new Agent({ provider });
    await agent.chat("Hello");
    // Only 1 message, too short to compact

    const countBefore = providerCallCount;
    await agent.compact();

    // No extra provider call for summary
    expect(providerCallCount).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// 7. Token tracking and showCost()
// ---------------------------------------------------------------------------

describe("token tracking", () => {
  test("accumulates input and output tokens across multiple turns", async () => {
    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 1000 * callCount, output_tokens: 100 * callCount },
        });
      },
    };

    const agent = new Agent({ provider });
    await agent.chat("Turn 1"); // 1000 in, 100 out
    await agent.chat("Turn 2"); // 2000 in, 200 out

    const logSpy: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logSpy.push(args.join(" "));

    try {
      agent.showCost();
    } finally {
      console.log = origLog;
    }

    // Total: 3000 input, 300 output, 3300 total
    expect(logSpy.length).toBe(1);
    expect(logSpy[0]).toContain("3,000");  // input
    expect(logSpy[0]).toContain("300");    // output
    expect(logSpy[0]).toContain("3,300");  // total
  });

  test("token counts include tool-use sub-turns", async () => {
    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount === 1) {
          return makeMessage({
            stop_reason: "tool_use",
            usage: { input_tokens: 500, output_tokens: 50 },
            content: [
              { type: "tool_use", id: "tu_1", name: "read_file", input: {} },
            ],
          });
        }
        return makeMessage({
          stop_reason: "end_turn",
          usage: { input_tokens: 800, output_tokens: 80 },
        });
      },
    };

    const agent = new Agent({
      provider,
      executeTool: async () => "ok",
    });

    await agent.chat("Read file");
    // Two API calls: tool_use (500/50) + end_turn (800/80)

    const logSpy: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logSpy.push(args.join(" "));

    try {
      agent.showCost();
    } finally {
      console.log = origLog;
    }

    // Total: 1300 input, 130 output
    expect(logSpy[0]).toContain("1,300");
    expect(logSpy[0]).toContain("130");
  });
});

// ---------------------------------------------------------------------------
// 8. Compression pipeline ordering
// ---------------------------------------------------------------------------

describe("compression pipeline ordering", () => {
  test("budget runs before snip (Tier 1 before Tier 2)", async () => {
    // If budget trims content first, snip sees smaller content.
    // Verify both run by checking their combined effects.
    // Setup: 5 read_file calls to same file with large content at >70% utilization.
    // Budget (Tier 1) trims content to 15K, then snip (Tier 2) removes dups.
    const largeContent = "x".repeat(20_000); // under 30KB persist threshold

    const tools = [
      { id: "tu_1", name: "read_file", input: { file_path: "/src/main.ts" } },
      { id: "tu_2", name: "read_file", input: { file_path: "/src/a.ts" } },
      { id: "tu_3", name: "read_file", input: { file_path: "/src/b.ts" } },
      { id: "tu_4", name: "read_file", input: { file_path: "/src/main.ts" } },
      { id: "tu_5", name: "read_file", input: { file_path: "/src/c.ts" } },
    ];

    const toolMsgs = tools.map((t) =>
      makeMessage({
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 160_000, output_tokens: 5 }, // 80%
        content: [{ type: "tool_use", ...t }],
      }),
    );
    const endMsg = makeMessage({
      stop_reason: "end_turn",
      usage: { input_tokens: 160_000, output_tokens: 5 },
    });

    let callCount = 0;
    const provider: Provider = {
      createMessage: async () => {
        callCount++;
        if (callCount <= 5) return toolMsgs[callCount - 1];
        return endMsg;
      },
    };

    const agent = new Agent({
      provider,
      executeTool: async () => largeContent,
    });

    await agent.chat("Read files");

    const msgs = agent.getMessages();
    const toolResults = msgs
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) =>
        (m.content as any[]).filter((b: any) => b.type === "tool_result"),
      );

    // tu_1 (main.ts dup): snipped by Tier 2
    expect(toolResults[0].content).toBe("[Content snipped - re-read if needed]");

    // tu_2 (a.ts): unique file, not snipped, but budgeted by Tier 1
    // At 80% utilization, budget is 15K, and 20K content > 15K → trimmed
    expect(toolResults[1].content).toContain("budgeted");
    expect(toolResults[1].content.length).toBeLessThanOrEqual(15_100);

    // tu_3-5: protected by last-3, but still budgeted
    for (let i = 2; i < 5; i++) {
      // Protected from snip, but budget still applies
      if (toolResults[i].content !== "[Content snipped - re-read if needed]") {
        expect(toolResults[i].content.length).toBeLessThanOrEqual(15_100);
      }
    }
  });
});
