import type Anthropic from "@anthropic-ai/sdk";

// Re-export SDK types used throughout the core
export type MessageParam = Anthropic.Messages.MessageParam;
export type Message = Anthropic.Messages.Message;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type TextBlock = Anthropic.Messages.TextBlock;
export type StopReason = Anthropic.Messages.Message["stop_reason"];

// ---------------------------------------------------------------------------
// Query result — final return value of a completed turn
// ---------------------------------------------------------------------------

export interface QueryResult {
  response: Message;
  messages: MessageParam[];
}

// ---------------------------------------------------------------------------
// Tool result — returned by tool execution
// ---------------------------------------------------------------------------

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Token limit constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = 16_384;
export const ESCALATED_MAX_TOKENS = 65_536;
export const MAX_RECOVERY_RETRIES = 3;
export const MAX_COMPACT_RETRIES = 3;
