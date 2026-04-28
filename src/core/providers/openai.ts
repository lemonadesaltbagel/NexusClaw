// ---------------------------------------------------------------------------
// OpenAIProvider — streams via the OpenAI SDK (compatible with any
// OpenAI-compatible API endpoint).
// ---------------------------------------------------------------------------

import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam } from "@/core/types";
import type { Provider, StreamParams } from "@/core/provider";
import type { ToolDef } from "@/tools/definitions";

export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor(client: OpenAI) {
    this.client = client;
  }

  async createMessage(params: StreamParams): Promise<Message> {
    const { model, maxTokens, messages, system, tools, signal, onText } =
      params;

    const openaiTools = tools?.length
      ? toOpenAITools(tools as unknown as Array<Omit<ToolDef, "deferred">>)
      : undefined;
    const openaiMessages = toOpenAIMessages(messages, system);

    const stream = await this.client.chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
        tools: openaiTools,
        messages: openaiMessages,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    // Accumulate streamed chunks into a complete response
    let content = "";
    let firstText = true;
    const toolCalls: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();
    let finishReason = "";
    let usage:
      | { prompt_tokens: number; completion_tokens: number }
      | undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens,
        };
      }

      if (!delta) continue;

      if (delta.content) {
        if (firstText) {
          onText?.("\n");
          firstText = false;
        }
        onText?.(delta.content);
        content += delta.content;
      }

      // Tool call deltas arrive in fragments, accumulate by index
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCalls.get(tc.index);
          if (existing) {
            if (tc.function?.arguments)
              existing.arguments += tc.function.arguments;
          } else {
            toolCalls.set(tc.index, {
              id: tc.id || "",
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            });
          }
        }
      }

      if (chunk.choices[0]?.finish_reason)
        finishReason = chunk.choices[0].finish_reason;
    }

    // Convert to internal (Anthropic-based) Message format
    const anthropicContent: any[] = [];
    if (content) {
      anthropicContent.push({ type: "text", text: content });
    }
    if (toolCalls.size > 0) {
      const sorted = Array.from(toolCalls.entries())
        .sort(([a], [b]) => a - b)
        .map(([_, tc]) => tc);
      for (const tc of sorted) {
        anthropicContent.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments),
        });
      }
    }

    return {
      id: "stream",
      type: "message",
      role: "assistant",
      content: anthropicContent,
      model,
      stop_reason:
        finishReason === "tool_calls" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: usage
        ? {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
          }
        : { input_tokens: 0, output_tokens: 0 },
    } as unknown as Message;
  }
}

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
              content:
                typeof tr.content === "string"
                  ? tr.content
                  : JSON.stringify(tr.content),
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

        const toolCallsList: OpenAI.ChatCompletionMessageToolCall[] =
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
          ...(toolCallsList.length > 0 && { tool_calls: toolCallsList }),
        });
      }
    }
  }

  return result;
}
