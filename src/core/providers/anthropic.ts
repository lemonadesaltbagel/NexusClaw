// ---------------------------------------------------------------------------
// AnthropicProvider — streams via the Anthropic SDK.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@/core/types";
import { THINKING_MAX_TOKENS } from "@/core/types";
import type { Provider, StreamParams } from "@/core/provider";

export class AnthropicProvider implements Provider {
  private client: Anthropic;

  constructor(client: Anthropic) {
    this.client = client;
  }

  async createMessage(params: StreamParams): Promise<Message> {
    const {
      model,
      maxTokens,
      messages,
      system,
      tools,
      thinkingMode,
      signal,
      onText,
    } = params;

    const effectiveMaxTokens =
      thinkingMode !== "disabled"
        ? Math.max(maxTokens, THINKING_MAX_TOKENS)
        : maxTokens;

    const createParams: Record<string, unknown> = {
      model,
      max_tokens: effectiveMaxTokens,
      messages,
      ...(system !== undefined && { system }),
      ...(tools?.length && { tools }),
    };

    if (thinkingMode === "enabled") {
      createParams.thinking = {
        type: "enabled",
        budget_tokens: effectiveMaxTokens - 1,
      };
    } else if (thinkingMode === "adaptive") {
      createParams.thinking = { type: "enabled", budget_tokens: 10_000 };
    }

    const stream = this.client.messages.stream(createParams as any, {
      signal,
    });

    stream.on("text", (delta) => onText?.(delta));

    const finalMessage = await stream.finalMessage();

    // When thinking is active, strip thinking blocks from completed turns
    // (no tool_use) to avoid wasting context in subsequent turns.
    // Turns with tool_use must keep thinking blocks — the API requires
    // the signature for validation when tool_result is sent back.
    if (thinkingMode !== "disabled") {
      const hasToolUse = finalMessage.content.some(
        (block: any) => block.type === "tool_use",
      );
      if (!hasToolUse) {
        (finalMessage as any).content = finalMessage.content.filter(
          (block: any) => block.type !== "thinking",
        );
      }
    }

    return finalMessage as Message;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an error is an Anthropic "prompt too long" error.
 * Exported so the Agent can use it for recovery logic.
 */
export function isPromptTooLongError(err: unknown): boolean {
  if (err instanceof Anthropic.BadRequestError) {
    const msg = String(err.message).toLowerCase();
    return (
      msg.includes("prompt is too long") || msg.includes("prompt_too_long")
    );
  }
  return false;
}
