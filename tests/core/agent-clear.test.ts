import { test, expect, describe } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "@/core/agent";
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

function fakeStream(msg: Message) {
  return {
    on(_event: string, _cb: (delta: string) => void) {},
    async finalMessage() {
      return msg;
    },
  };
}

function mockClient(streamFn: (...args: unknown[]) => unknown): Anthropic {
  return {
    messages: { stream: streamFn },
  } as unknown as Anthropic;
}

// ---------------------------------------------------------------------------
// clearMessages
// ---------------------------------------------------------------------------

describe("clearMessages", () => {
  test("empties message history", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const client = mockClient(() => fakeStream(msg));

    const agent = new Agent({ client });
    await agent.chatAnthropic("First message");

    expect(agent.getMessages().length).toBeGreaterThan(0);

    agent.clearMessages();
    expect(agent.getMessages()).toHaveLength(0);
  });

  test("agent works normally after clearing messages", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const client = mockClient(() => fakeStream(msg));

    const agent = new Agent({ client });
    await agent.chatAnthropic("First");
    agent.clearMessages();
    await agent.chatAnthropic("Second");

    const msgs = agent.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "Second" });
  });
});
