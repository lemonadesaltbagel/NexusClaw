/**
 * Shared test mock factories for Anthropic SDK types.
 * These provide defaults for required fields that tests don't care about.
 */
import type Anthropic from "@anthropic-ai/sdk";

type Message = Anthropic.Messages.Message;
type ContentBlock = Anthropic.Messages.ContentBlock;
type Usage = Anthropic.Messages.Usage;

export function mockUsage(overrides: Partial<Usage> = {}): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: "standard",
    ...overrides,
  } as Usage;
}

export function mockTextBlock(text: string): ContentBlock {
  return {
    type: "text",
    text,
    citations: null,
  } as ContentBlock;
}

export function mockToolUseBlock(opts: {
  id: string;
  name: string;
  input: unknown;
}): ContentBlock {
  return {
    type: "tool_use",
    id: opts.id,
    name: opts.name,
    input: opts.input,
    caller: { type: "direct" },
  } as ContentBlock;
}

export function mockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-20250514",
    content: [mockTextBlock("ok")],
    container: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: mockUsage(),
    ...overrides,
  } as Message;
}
