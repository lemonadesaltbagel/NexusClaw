import type Anthropic from "@anthropic-ai/sdk";
import { queryLoop } from "@/core/loop";
import {
  ContinuationKind,
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  type ContinuationSignal,
  type LoopFeedback,
  type Message,
  type MessageParam,
  type QueryResult,
  type ToolUseBlock,
} from "@/core/types";

// ---------------------------------------------------------------------------
// QueryEngine — session-level orchestrator.
//
// Manages the full conversation lifecycle: message history, tool dispatch,
// context compaction, and token-limit recovery. Drives the queryLoop
// generator by consuming ContinuationSignals and feeding back LoopFeedback.
// ---------------------------------------------------------------------------

export interface QueryEngineOptions {
  client: Anthropic;
  model?: string;
  maxTokens?: number;
  system?: string | Anthropic.Messages.TextBlockParam[];
  tools?: Anthropic.Messages.Tool[];
  /**
   * Execute a tool call. Returns the string result to send back to the model.
   * Placeholder — tool system not yet implemented.
   */
  executeTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
  /**
   * Collapse pending cacheable context to free token space.
   * Returns compacted messages. Placeholder — not yet implemented.
   */
  collapseContext?: (messages: MessageParam[]) => Promise<MessageParam[]>;
  /**
   * Force a full summary compaction of conversation history.
   * Returns compacted messages. Placeholder — not yet implemented.
   */
  compactMessages?: (messages: MessageParam[]) => Promise<MessageParam[]>;
  /**
   * Stop hook — return true to *block* the turn from completing.
   * Placeholder — hook system not yet implemented.
   */
  checkStopHook?: (response: Message) => Promise<boolean>;
}

export class QueryEngine {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private system?: string | Anthropic.Messages.TextBlockParam[];
  private tools?: Anthropic.Messages.Tool[];
  private messages: MessageParam[] = [];

  // Pluggable handlers (stubs until subsystems are implemented)
  private executeTool: NonNullable<QueryEngineOptions["executeTool"]>;
  private collapseContext: NonNullable<QueryEngineOptions["collapseContext"]>;
  private compactMessages: NonNullable<QueryEngineOptions["compactMessages"]>;
  private checkStopHook?: QueryEngineOptions["checkStopHook"];

  constructor(options: QueryEngineOptions) {
    this.client = options.client;
    this.model = options.model ?? "claude-sonnet-4-5-20250514";
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.system = options.system;
    this.tools = options.tools;

    this.executeTool =
      options.executeTool ??
      (async (name) => `Tool "${name}" not implemented`);
    this.collapseContext =
      options.collapseContext ?? (async (msgs) => msgs);
    this.compactMessages =
      options.compactMessages ?? (async (msgs) => msgs);
    this.checkStopHook = options.checkStopHook;
  }

  /** Full message history (read-only snapshot). */
  getMessages(): readonly MessageParam[] {
    return this.messages;
  }

  /** Push a user message and drive one full query turn to completion. */
  async query(userMessage: string): Promise<QueryResult> {
    this.messages.push({ role: "user", content: userMessage });

    let currentMaxTokens = this.maxTokens;

    const gen = queryLoop({
      client: this.client,
      messages: [...this.messages],
      model: this.model,
      maxTokens: currentMaxTokens,
      system: this.system,
      tools: this.tools,
      checkStopHook: this.checkStopHook,
    });

    // Kick off the generator — first .next() has no argument
    let iter = await gen.next();

    while (!iter.done) {
      const signal: ContinuationSignal = iter.value;
      const feedback = await this.handleSignal(signal, currentMaxTokens);
      currentMaxTokens = feedback.maxTokens;
      iter = await gen.next(feedback);
    }

    // Turn complete — persist final messages into session history
    const result: QueryResult = iter.value;
    this.messages = result.messages;
    return result;
  }

  // -----------------------------------------------------------------------
  // Signal handlers
  // -----------------------------------------------------------------------

  private async handleSignal(
    signal: ContinuationSignal,
    currentMaxTokens: number,
  ): Promise<LoopFeedback> {
    switch (signal.kind) {
      case ContinuationKind.NextTurn:
        return this.handleNextTurn(signal, currentMaxTokens);

      case ContinuationKind.CollapseDrainRetry:
        return this.handleCollapseDrain(currentMaxTokens);

      case ContinuationKind.ReactiveCompactRetry:
        return this.handleReactiveCompact(currentMaxTokens);

      case ContinuationKind.MaxOutputTokensEscalate:
        return this.handleEscalate(signal);

      case ContinuationKind.MaxOutputTokensRecovery:
        return this.handleRecovery(signal, currentMaxTokens);

      case ContinuationKind.StopHookBlocking:
        return this.handleStopHookBlocking(signal, currentMaxTokens);

      case ContinuationKind.TokenBudgetContinuation:
        return this.handleTokenBudgetContinuation(signal, currentMaxTokens);
    }
  }

  /** 1. next_turn — execute tools, append results, continue. */
  private async handleNextTurn(
    signal: ContinuationSignal,
    maxTokens: number,
  ): Promise<LoopFeedback> {
    const response = signal.response!;
    const toolBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    // Append assistant message with the full response content
    const updatedMessages: MessageParam[] = [
      ...this.messages,
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: await Promise.all(
          toolBlocks.map(async (block) => ({
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: await this.executeTool(
              block.name,
              block.input as Record<string, unknown>,
            ),
          })),
        ),
      },
    ];

    this.messages = updatedMessages;
    return { messages: updatedMessages, maxTokens };
  }

  /** 2. collapse_drain_retry — commit pending collapse to free space. */
  private async handleCollapseDrain(maxTokens: number): Promise<LoopFeedback> {
    const collapsed = await this.collapseContext(this.messages);
    this.messages = collapsed;
    return { messages: collapsed, maxTokens };
  }

  /** 3. reactive_compact_retry — force full summary compaction. */
  private async handleReactiveCompact(
    maxTokens: number,
  ): Promise<LoopFeedback> {
    const compacted = await this.compactMessages(this.messages);
    this.messages = compacted;
    return { messages: compacted, maxTokens };
  }

  /** 4. max_output_tokens_escalate — bump 16K → 64K, retry with assistant prefix. */
  private async handleEscalate(
    signal: ContinuationSignal,
  ): Promise<LoopFeedback> {
    const response = signal.response!;
    const escalated = ESCALATED_MAX_TOKENS;

    // Append the truncated assistant response and a continuation prompt
    // so the model can pick up where it left off
    const updatedMessages: MessageParam[] = [
      ...this.messages,
      { role: "assistant", content: response.content },
      { role: "user", content: "Your response was truncated. Please continue from where you left off." },
    ];

    this.messages = updatedMessages;
    return { messages: updatedMessages, maxTokens: escalated };
  }

  /** 5. max_output_tokens_recovery — inject continuation prompt, retry ≤3×. */
  private async handleRecovery(
    signal: ContinuationSignal,
    maxTokens: number,
  ): Promise<LoopFeedback> {
    const response = signal.response!;

    const updatedMessages: MessageParam[] = [
      ...this.messages,
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: `Your response was truncated (recovery attempt ${signal.retryCount}/${3}). Please continue from where you left off.`,
      },
    ];

    this.messages = updatedMessages;
    return { messages: updatedMessages, maxTokens };
  }

  /** 6. stop_hook_blocking — hook blocked completion, inject continue signal. */
  private async handleStopHookBlocking(
    signal: ContinuationSignal,
    maxTokens: number,
  ): Promise<LoopFeedback> {
    const response = signal.response!;

    const updatedMessages: MessageParam[] = [
      ...this.messages,
      { role: "assistant", content: response.content },
      {
        role: "user",
        content:
          "[System: The task is not yet complete. Please continue working on the task.]",
      },
    ];

    this.messages = updatedMessages;
    return { messages: updatedMessages, maxTokens };
  }

  /** 7. token_budget_continuation — API budget exhausted, continue generation. */
  private async handleTokenBudgetContinuation(
    signal: ContinuationSignal,
    maxTokens: number,
  ): Promise<LoopFeedback> {
    const response = signal.response!;

    // Append the partial response and ask the model to continue
    const updatedMessages: MessageParam[] = [
      ...this.messages,
      { role: "assistant", content: response.content },
      { role: "user", content: "[System: Your token budget was exhausted. Please continue.]" },
    ];

    this.messages = updatedMessages;
    return { messages: updatedMessages, maxTokens };
  }
}
