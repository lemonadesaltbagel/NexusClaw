// ---------------------------------------------------------------------------
// OpenAI SDK helpers — message conversion and tool format adapters.
// ---------------------------------------------------------------------------

import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@/core/types";
import type { ToolDef } from "@/tools/definitions";

// ---------------------------------------------------------------------------
// Tool definition converter
// ---------------------------------------------------------------------------

/**
 * Convert internal tool definitions to OpenAI's ChatCompletionTool format.
 */
export function toOpenAITools(
  tools: Array<Omit<ToolDef, "deferred">>,
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ---------------------------------------------------------------------------
// Message format conversion: Anthropic MessageParam[] → OpenAI messages
// ---------------------------------------------------------------------------

export type OpenAIMessage = OpenAI.ChatCompletionMessageParam;

/**
 * Convert Anthropic-format messages to OpenAI ChatCompletion messages.
 */
export function toOpenAIMessages(
  messages: readonly MessageParam[],
  system?: string | Anthropic.Messages.TextBlockParam[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // Prepend system message
  if (system) {
    const systemText =
      typeof system === "string"
        ? system
        : system.map((b) => b.text).join("\n");
    result.push({ role: "system", content: systemText });
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      // User messages can be string or array of content blocks
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Check if it's tool_result blocks (from tool execution)
        const toolResults = msg.content.filter(
          (b: any) => b.type === "tool_result",
        );
        if (toolResults.length > 0) {
          // Convert tool_result blocks to OpenAI tool messages
          for (const tr of toolResults as any[]) {
            result.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
            });
          }
        } else {
          // Regular content blocks — extract text
          const text = (msg.content as any[])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          if (text) result.push({ role: "user", content: text });
        }
      }
    } else if (msg.role === "assistant") {
      // Assistant messages: extract text + tool_use blocks
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = (msg.content as any[])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolUseBlocks = (msg.content as any[]).filter(
          (b) => b.type === "tool_use",
        );

        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] =
          toolUseBlocks.map((b) => ({
            id: b.id,
            type: "function" as const,
            function: {
              name: b.name,
              arguments:
                typeof b.input === "string"
                  ? b.input
                  : JSON.stringify(b.input),
            },
          }));

        result.push({
          role: "assistant",
          content: textParts || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        });
      }
    }
  }

  return result;
}
