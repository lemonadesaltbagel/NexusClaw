import type Anthropic from "@anthropic-ai/sdk";

// Re-export SDK types used throughout the core loop
export type MessageParam = Anthropic.Messages.MessageParam;
export type Message = Anthropic.Messages.Message;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type TextBlock = Anthropic.Messages.TextBlock;
export type StopReason = Anthropic.Messages.Message["stop_reason"];

// ---------------------------------------------------------------------------
// Continuation signals — the 7 points where queryLoop yields control back
// to QueryEngine for side-effects before resuming.
// ---------------------------------------------------------------------------

export const ContinuationKind = {
  /** Model called a tool. Execute tool, push result, continue. */
  NextTurn: "next_turn",
  /** Prompt-too-long error with pending collapse ops. Commit collapse, retry. */
  CollapseDrainRetry: "collapse_drain_retry",
  /** Prompt-too-long error, collapse insufficient. Force full compaction, retry. */
  ReactiveCompactRetry: "reactive_compact_retry",
  /** Output truncated (max_tokens), first time. Escalate limit 16K→64K, retry. */
  MaxOutputTokensEscalate: "max_output_tokens_escalate",
  /** Output truncated, escalation unavailable. Inject continuation prompt, retry ≤3×. */
  MaxOutputTokensRecovery: "max_output_tokens_recovery",
  /** Task complete but stop hook blocked. Continue execution loop. */
  StopHookBlocking: "stop_hook_blocking",
  /** API-side token budget exhausted (pause_turn). Continue generation. */
  TokenBudgetContinuation: "token_budget_continuation",
} as const;

export type ContinuationKind =
  (typeof ContinuationKind)[keyof typeof ContinuationKind];

export interface ContinuationSignal {
  kind: ContinuationKind;
  response?: Message;
  error?: unknown;
  /** For max_output_tokens_recovery: how many recovery retries so far. */
  retryCount?: number;
}

// ---------------------------------------------------------------------------
// Feedback — what the engine passes back into the generator via .next()
// ---------------------------------------------------------------------------

export interface LoopFeedback {
  messages: MessageParam[];
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Query result — final return value of a completed query loop turn
// ---------------------------------------------------------------------------

export interface QueryResult {
  response: Message;
  messages: MessageParam[];
}

// ---------------------------------------------------------------------------
// Parameters for a single queryLoop invocation
// ---------------------------------------------------------------------------

export interface QueryLoopParams {
  client: Anthropic;
  messages: MessageParam[];
  model: string;
  maxTokens: number;
  system?: string | Anthropic.Messages.TextBlockParam[];
  tools?: Anthropic.Messages.Tool[];
  /**
   * Called when the model returns end_turn.
   * Return `true` if the stop hook *blocks* completion (i.e. loop should continue).
   * Placeholder — hook system not yet implemented.
   */
  checkStopHook?: (response: Message) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Token limit constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = 16_384;
export const ESCALATED_MAX_TOKENS = 65_536;
export const MAX_RECOVERY_RETRIES = 3;
export const MAX_COMPACT_RETRIES = 3;
