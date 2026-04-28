// ---------------------------------------------------------------------------
// Provider — abstraction layer for LLM API backends.
//
// Both Anthropic and OpenAI-compatible providers implement this interface,
// allowing the Agent to be completely provider-agnostic.
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam, ThinkingMode } from "@/core/types";

// ---------------------------------------------------------------------------
// Streaming parameters passed to the provider
// ---------------------------------------------------------------------------

export interface StreamParams {
  model: string;
  maxTokens: number;
  messages: readonly MessageParam[];
  system?: string | Anthropic.Messages.TextBlockParam[];
  tools?: Anthropic.Messages.Tool[];
  thinkingMode: ThinkingMode;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface Provider {
  /**
   * Send a streaming request and return the assembled response.
   * The returned Message uses the internal (Anthropic-based) format
   * regardless of the underlying API.
   */
  createMessage(params: StreamParams): Promise<Message>;
}
