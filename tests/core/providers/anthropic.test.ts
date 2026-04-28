import { test, expect, describe } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, isPromptTooLongError } from "@/core/providers/anthropic";
import { THINKING_MAX_TOKENS, type Message } from "@/core/types";
import type { StreamParams } from "@/core/provider";

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

function fakeStream(msg: Message, opts?: { textDeltas?: string[] }) {
  let textCb: ((delta: string) => void) | null = null;
  return {
    on(event: string, cb: (delta: string) => void) {
      if (event === "text") textCb = cb;
    },
    async finalMessage() {
      if (opts?.textDeltas && textCb) {
        for (const d of opts.textDeltas) textCb(d);
      }
      return msg;
    },
  };
}

function mockClient(streamFn: (...args: unknown[]) => unknown): Anthropic {
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
        { type: "text", text: "Final answer" },
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
        { type: "text", text: "Let me use a tool" },
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
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
// isPromptTooLongError
// ---------------------------------------------------------------------------

describe("isPromptTooLongError", () => {
  test("returns true for Anthropic BadRequestError with prompt too long", () => {
    const err = new Anthropic.BadRequestError(
      "prompt is too long",
      { status: 400, headers: {} as any, error: undefined, request: {} as any, body: undefined },
      undefined as any,
    );
    expect(isPromptTooLongError(err)).toBe(true);
  });

  test("returns false for non-Anthropic errors", () => {
    expect(isPromptTooLongError(new Error("prompt is too long"))).toBe(false);
  });

  test("returns false for other BadRequestErrors", () => {
    const err = new Anthropic.BadRequestError(
      "invalid model",
      { status: 400, headers: {} as any, error: undefined, request: {} as any, body: undefined },
      undefined as any,
    );
    expect(isPromptTooLongError(err)).toBe(false);
  });
});
