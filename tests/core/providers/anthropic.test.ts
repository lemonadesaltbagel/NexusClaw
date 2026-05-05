import { test, expect, describe } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, isPromptTooLongError } from "@/core/providers/anthropic";
import { THINKING_MAX_TOKENS, type Message } from "@/core/types";
import type { StreamParams } from "@/core/provider";
import { mockUsage, mockTextBlock, mockToolUseBlock, mockMessage } from "../../_helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  overrides: Partial<Message> & { stop_reason: Message["stop_reason"] },
): Message {
  return mockMessage({
    model: "claude-sonnet-4-5-20250514",
    content: overrides.content ?? [mockTextBlock("Hello")],
    usage: mockUsage({ input_tokens: 10, output_tokens: 5 }),
    ...overrides,
  });
}

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; partial_json?: string };
}

function fakeStream(
  msg: Message,
  opts?: { textDeltas?: string[]; streamEvents?: StreamEvent[] },
) {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  return {
    on(event: string, cb: (...args: any[]) => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
    },
    async finalMessage() {
      const textCbs = listeners.get("text") ?? [];
      if (opts?.textDeltas) {
        for (const d of opts.textDeltas) textCbs.forEach((cb) => cb(d));
      }
      const streamEventCbs = listeners.get("streamEvent") ?? [];
      if (opts?.streamEvents) {
        for (const e of opts.streamEvents) streamEventCbs.forEach((cb) => cb(e));
      }
      return msg;
    },
  };
}

function mockClient(streamFn: (...args: any[]) => any): Anthropic {
  return {
    messages: { stream: streamFn },
  } as unknown as Anthropic;
}

function baseParams(overrides?: Partial<StreamParams>): StreamParams {
  return {
    model: "claude-sonnet-4-5-20250514",
    maxTokens: 16_384,
    messages: [{ role: "user", content: "Hi" }],
    thinkingMode: "disabled",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Thinking mode — param construction
// ---------------------------------------------------------------------------

describe("AnthropicProvider thinking mode", () => {
  test("enabled mode sends thinking param and raises max_tokens", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let capturedParams: Record<string, unknown> = {};
    const client = mockClient((params: Record<string, unknown>) => {
      capturedParams = params;
      return fakeStream(msg);
    });

    const provider = new AnthropicProvider(client);
    await provider.createMessage(baseParams({ thinkingMode: "enabled" }));

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

    const provider = new AnthropicProvider(client);
    await provider.createMessage(baseParams({ thinkingMode: "adaptive" }));

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

    const provider = new AnthropicProvider(client);
    await provider.createMessage(baseParams({ thinkingMode: "disabled" }));

    expect(capturedParams.thinking).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Thinking block stripping
// ---------------------------------------------------------------------------

describe("AnthropicProvider thinking block stripping", () => {
  test("strips thinking blocks from completed turns (no tool_use)", async () => {
    const msg = makeMessage({
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "internal reasoning" } as any,
        mockTextBlock("Final answer"),
      ],
    });
    const client = mockClient(() => fakeStream(msg));

    const provider = new AnthropicProvider(client);
    const result = await provider.createMessage(baseParams({ thinkingMode: "enabled" }));

    const thinkingBlocks = result.content.filter((b: any) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(0);

    const textBlocks = result.content.filter((b: any) => b.type === "text");
    expect(textBlocks).toHaveLength(1);
  });

  test("preserves thinking blocks on tool_use turns", async () => {
    const msg = makeMessage({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "internal reasoning" } as any,
        mockTextBlock("Let me use a tool"),
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
      ],
    });
    const client = mockClient(() => fakeStream(msg));

    const provider = new AnthropicProvider(client);
    const result = await provider.createMessage(baseParams({ thinkingMode: "enabled" }));

    const thinkingBlocks = result.content.filter((b: any) => b.type === "thinking");
    expect(thinkingBlocks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Text streaming
// ---------------------------------------------------------------------------

describe("AnthropicProvider streaming", () => {
  test("onText receives text deltas", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    const client = mockClient(() => fakeStream(msg, { textDeltas: ["Hel", "lo"] }));

    const deltas: string[] = [];
    const provider = new AnthropicProvider(client);
    await provider.createMessage(baseParams({ onText: (d) => deltas.push(d) }));

    expect(deltas).toEqual(["Hel", "lo"]);
  });
});

// ---------------------------------------------------------------------------
// Tool block tracking via streamEvent
// ---------------------------------------------------------------------------

describe("AnthropicProvider tool block tracking", () => {
  test("onToolUse fires for each completed tool block with parsed input", async () => {
    const msg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
      ],
    });

    const streamEvents: StreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path"' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ': "a.txt"}' } },
      { type: "content_block_stop", index: 0 },
    ];

    const client = mockClient(() => fakeStream(msg, { streamEvents }));
    const received: { id: string; name: string; input: Record<string, unknown> }[] = [];

    const provider = new AnthropicProvider(client);
    await provider.createMessage(
      baseParams({ onToolUse: (block) => received.push(block) }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      id: "tu_1",
      name: "read_file",
      input: { path: "a.txt" },
    });
  });

  test("tracks multiple tool blocks independently", async () => {
    const msg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
        mockToolUseBlock({ id: "tu_2", name: "write_file", input: { path: "b.txt", content: "hi" } }),
      ],
    });

    const streamEvents: StreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_2", name: "write_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "a.txt"}' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path": "b.txt"' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ', "content": "hi"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
    ];

    const client = mockClient(() => fakeStream(msg, { streamEvents }));
    const received: { id: string; name: string; input: Record<string, unknown> }[] = [];

    const provider = new AnthropicProvider(client);
    await provider.createMessage(
      baseParams({ onToolUse: (block) => received.push(block) }),
    );

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ id: "tu_1", name: "read_file", input: { path: "a.txt" } });
    expect(received[1]).toEqual({ id: "tu_2", name: "write_file", input: { path: "b.txt", content: "hi" } });
  });

  test("skips tool block with malformed JSON without throwing", async () => {
    const msg = makeMessage({
      stop_reason: "tool_use",
      content: [
        mockToolUseBlock({ id: "tu_1", name: "read_file", input: { path: "a.txt" } }),
      ],
    });

    const streamEvents: StreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": ' } },
      // missing closing brace — malformed JSON
      { type: "content_block_stop", index: 0 },
    ];

    const client = mockClient(() => fakeStream(msg, { streamEvents }));
    const received: { id: string; name: string; input: Record<string, unknown> }[] = [];

    const provider = new AnthropicProvider(client);
    // Should not throw
    await provider.createMessage(
      baseParams({ onToolUse: (block) => received.push(block) }),
    );

    expect(received).toHaveLength(0);
  });

  test("ignores non-tool content blocks in streamEvent tracking", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });

    const streamEvents: StreamEvent[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta" } },
      { type: "content_block_stop", index: 0 },
    ];

    const client = mockClient(() => fakeStream(msg, { streamEvents }));
    const received: { id: string; name: string; input: Record<string, unknown> }[] = [];

    const provider = new AnthropicProvider(client);
    await provider.createMessage(
      baseParams({ onToolUse: (block) => received.push(block) }),
    );

    expect(received).toHaveLength(0);
  });

  test("does not register streamEvent listener when onToolUse is not provided", async () => {
    const msg = makeMessage({ stop_reason: "end_turn" });
    let registeredEvents: string[] = [];

    const client = mockClient(() => {
      const s = fakeStream(msg);
      const origOn = s.on.bind(s);
      s.on = (event: string, cb: any) => {
        registeredEvents.push(event);
        return origOn(event, cb);
      };
      return s;
    });

    const provider = new AnthropicProvider(client);
    await provider.createMessage(baseParams());

    expect(registeredEvents).toContain("text");
    expect(registeredEvents).not.toContain("streamEvent");
  });
});

// ---------------------------------------------------------------------------
// isPromptTooLongError
// ---------------------------------------------------------------------------

describe("isPromptTooLongError", () => {
  test("returns true for Anthropic BadRequestError with prompt too long", () => {
    const err = new Anthropic.BadRequestError(
      400,
      undefined,
      "prompt is too long",
      new Headers(),
    );
    expect(isPromptTooLongError(err)).toBe(true);
  });

  test("returns false for non-Anthropic errors", () => {
    expect(isPromptTooLongError(new Error("prompt is too long"))).toBe(false);
  });

  test("returns false for other BadRequestErrors", () => {
    const err = new Anthropic.BadRequestError(
      400,
      undefined,
      "invalid model",
      new Headers(),
    );
    expect(isPromptTooLongError(err)).toBe(false);
  });
});
