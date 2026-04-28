import type Anthropic from "@anthropic-ai/sdk";

// Re-export SDK types used throughout the core
export type MessageParam = Anthropic.Messages.MessageParam;
export type Message = Anthropic.Messages.Message;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type TextBlock = Anthropic.Messages.TextBlock;
export type StopReason = Anthropic.Messages.Message["stop_reason"];

// ---------------------------------------------------------------------------
// Thinking mode
// ---------------------------------------------------------------------------

export type ThinkingMode = "disabled" | "enabled" | "adaptive";

// ---------------------------------------------------------------------------
// Permission modes — controls how tool permissions are handled
// ---------------------------------------------------------------------------

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions";

// ---------------------------------------------------------------------------
// Parsed CLI arguments
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  permissionMode: PermissionMode;
  model: string;
  apiBase?: string;
  resume: boolean;
  thinking: boolean;
  maxCost?: number;
  maxTurns?: number;
  prompt?: string;
}

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
export const THINKING_MAX_TOKENS = 128_000;
export const MAX_RECOVERY_RETRIES = 3;
export const MAX_COMPACT_RETRIES = 3;

// ---------------------------------------------------------------------------
// Tool system — shared types
// ---------------------------------------------------------------------------

/**
 * Context passed to every tool invocation, providing access to
 * environment state without coupling tools to the agent internals.
 */
export interface ToolContext {
  /** Absolute path of the working directory. */
  cwd: string;
  /** Read-only snapshot of current conversation messages. */
  messages: readonly MessageParam[];
  /** Abort signal propagated from the agent's AbortController. */
  signal?: AbortSignal;
  /** Additional context properties set by the host. */
  [key: string]: unknown;
}

/**
 * Permission check result.
 *
 * - `allow`: tool may proceed, optionally with a rewritten input.
 * - `deny`:  tool must not run; `reason` is shown to the model.
 * - `ask`:   host should prompt the user before proceeding.
 */
export type PermissionResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; message: string };

/**
 * Base interface for progress data emitted during tool execution.
 * Specific tools extend this with their own payload shapes.
 */
export interface ToolProgressData {
  /** Discriminator so renderers can switch on progress type. */
  type: string;
}

/**
 * Options bag passed to `description()` and `prompt()`.
 */
export interface ToolDescriptionOptions {
  /** Whether the tool is being described for the first time or mid-conversation. */
  isFirstUse: boolean;
  /** Current working directory (may influence usage instructions). */
  cwd: string;
}

/**
 * Options bag passed to rendering methods.
 */
export interface ToolRenderOptions {
  /** Whether to render in a compact/inline mode. */
  compact?: boolean;
  /** Whether the tool is currently executing. */
  isStreaming?: boolean;
}

/**
 * JSON Schema subset accepted by the Anthropic API for tool input schemas.
 */
export interface ToolInputJSONSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}
