import { test, expect, describe } from "bun:test";
import { Agent } from "@/core/agent";
import type { Provider } from "@/core/provider";
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

function mockProvider(): Provider {
  const msg = makeMessage({ stop_reason: "end_turn" });
  return {
    createMessage: async () => msg,
  };
}

// ---------------------------------------------------------------------------
// clearHistory
// ---------------------------------------------------------------------------

describe("clearHistory", () => {
  test("empties message history", async () => {
    const agent = new Agent({ provider: mockProvider() });
    await agent.chat("First message");

    expect(agent.getMessages().length).toBeGreaterThan(0);

    agent.clearHistory();
    expect(agent.getMessages()).toHaveLength(0);
  });

  test("agent works normally after clearing messages", async () => {
    const agent = new Agent({ provider: mockProvider() });
    await agent.chat("First");
    agent.clearHistory();
    await agent.chat("Second");

    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "Second" });
  });
});
