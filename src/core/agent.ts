import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_COMPACT_RETRIES,
  MAX_RECOVERY_RETRIES,
  type Message,
  type MessageParam,
  type QueryResult,
  type ToolUseBlock,
} from "@/core/types";

// ---------------------------------------------------------------------------
// Agent — single-class orchestrator for a conversational coding agent.
//
// Manages the full conversation lifecycle: API calls, message history, tool
// dispatch, context compaction, and token-limit recovery. chatAnthropic() is
// the core method that drives one full user→assistant turn to completion.
// ---------------------------------------------------------------------------

export interface AgentOptions {
  client: Anthropic;
  model?: string;
  maxTokens?: number;
  system?: string | Anthropic.Messages.TextBlockParam[];
  tools?: Anthropic.Messages.Tool[];
  /** Execute a tool call. Returns the string result to send back to the model. */
  executeTool?: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Collapse pending cacheable context to free token space. Returns compacted messages. */
  collapseContext?: (messages: MessageParam[]) => Promise<MessageParam[]>;
  /** Force a full summary compaction of conversation history. Returns compacted messages. */
  compactMessages?: (messages: MessageParam[]) => Promise<MessageParam[]>;
  /** Called for each text delta as the response streams in. */
  onText?: (delta: string) => void;
  /** Stop hook — return true to *block* the turn from completing. */
  checkStopHook?: (response: Message) => Promise<boolean>;
}

export class Agent {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private system?: string | Anthropic.Messages.TextBlockParam[];
  private tools?: Anthropic.Messages.Tool[];
  private messages: MessageParam[] = [];

  private executeTool: NonNullable<AgentOptions["executeTool"]>;
  private collapseContext: NonNullable<AgentOptions["collapseContext"]>;
  private compactMessages: NonNullable<AgentOptions["compactMessages"]>;
  private onText: (delta: string) => void;
  private checkStopHook?: AgentOptions["checkStopHook"];

  constructor(options: AgentOptions) {
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
    this.onText = options.onText ?? (() => {});
    this.checkStopHook = options.checkStopHook;
  }

  /** Full message history (read-only snapshot). */
  getMessages(): readonly MessageParam[] {
    return this.messages;
  }

  // -----------------------------------------------------------------------
  // chatAnthropic — core method driving one full user→assistant turn.
  // -----------------------------------------------------------------------

  async chatAnthropic(userMessage: string): Promise<QueryResult> {
    this.messages.push({ role: "user", content: userMessage });

    let currentMaxTokens = this.maxTokens;
    let hasEscalated = false;
    let recoveryRetries = 0;
    let collapseAttempted = false;
    let compactRetries = 0;
    let withheldError: unknown = null;

    while (true) {
      // ----- API call -----
      let response: Message;

      try {
        const stream = this.client.messages.stream({
          model: this.model,
          max_tokens: currentMaxTokens,
          messages: this.messages,
          ...(this.system !== undefined && { system: this.system }),
          ...(this.tools?.length && { tools: this.tools }),
        });

        stream.on("text", (delta) => this.onText(delta));

        response = (await stream.finalMessage()) as Message;
      } catch (err: unknown) {
        // ---- Prompt-too-long handling (2-stage, withhold error) ----
        if (isPromptTooLongError(err)) {
          withheldError = err;

          if (!collapseAttempted) {
            collapseAttempted = true;
            await this.handleCollapseDrain();
            continue;
          }

          if (compactRetries < MAX_COMPACT_RETRIES) {
            compactRetries++;
            await this.handleReactiveCompact();
            continue;
          }

          // Recovery exhausted — expose the withheld error
          throw withheldError;
        }

        // Non-PTL errors propagate directly
        throw err;
      }

      // API call succeeded — clear any withheld PTL error
      withheldError = null;

      // ----- Dispatch on stop_reason -----
      switch (response.stop_reason) {
        // ---- tool_use: model wants to use a tool ----
        case "tool_use": {
          await this.handleNextTurn(response);
          collapseAttempted = false; // reset PTL stage for new sub-turn
          continue;
        }

        // ---- max_tokens: output truncation ----
        case "max_tokens": {
          // First truncation → escalate (16K → 64K)
          if (!hasEscalated && currentMaxTokens < DEFAULT_MAX_TOKENS * 4) {
            hasEscalated = true;
            currentMaxTokens = this.handleEscalate(response);
            continue;
          }

          // Subsequent truncations → recovery via continuation prompt (≤3×)
          if (recoveryRetries < MAX_RECOVERY_RETRIES) {
            recoveryRetries++;
            this.handleRecovery(response, recoveryRetries);
            continue;
          }

          // Exhausted all recovery attempts — return truncated result
          return { response, messages: this.messages };
        }

        // ---- pause_turn: API-side token budget exhausted ----
        case "pause_turn": {
          this.handleTokenBudgetContinuation(response);
          continue;
        }

        // ---- end_turn / stop_sequence: natural completion ----
        case "end_turn":
        case "stop_sequence":
        default: {
          if (this.checkStopHook && (await this.checkStopHook(response))) {
            this.handleStopHookBlocking(response);
            continue;
          }

          // Turn genuinely complete
          return { response, messages: this.messages };
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Recovery & continuation handlers
  // -----------------------------------------------------------------------

  /** Execute tools serially, append assistant message + tool results. */
  private async handleNextTurn(response: Message): Promise<void> {
    const toolBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of toolBlocks) {
      let content: string;
      try {
        content = await this.executeTool(
          block.name,
          block.input as Record<string, unknown>,
        );
      } catch (err) {
        content = `Error executing tool ${block.name}: ${err instanceof Error ? err.message : String(err)}`;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content,
      });
    }

    this.messages = [
      ...this.messages,
      { role: "assistant", content: response.content },
      { role: "user", content: toolResults },
    ];
  }

  /** Commit pending collapse to free token space. */
  private async handleCollapseDrain(): Promise<void> {
    this.messages = await this.collapseContext(this.messages);
  }

  /** Force full summary compaction. */
  private async handleReactiveCompact(): Promise<void> {
    this.messages = await this.compactMessages(this.messages);
  }

  /** Bump max_tokens 16K → 64K, append truncated response + continuation prompt. */
  private handleEscalate(response: Message): number {
    this.messages = [
      ...this.messages,
      { role: "assistant", content: response.content },
      { role: "user", content: "Your response was truncated. Please continue from where you left off." },
    ];
    return ESCALATED_MAX_TOKENS;
  }

  /** Inject continuation prompt for subsequent truncation recovery. */
  private handleRecovery(response: Message, retryCount: number): void {
    this.messages = [
      ...this.messages,
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: `Your response was truncated (recovery attempt ${retryCount}/${MAX_RECOVERY_RETRIES}). Please continue from where you left off.`,
      },
    ];
  }

  /** Stop hook blocked completion — inject continue signal. */
  private handleStopHookBlocking(response: Message): void {
    this.messages = [
      ...this.messages,
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: "[System: The task is not yet complete. Please continue working on the task.]",
      },
    ];
  }

  /** API budget exhausted — continue generation. */
  private handleTokenBudgetContinuation(response: Message): void {
    this.messages = [
      ...this.messages,
      { role: "assistant", content: response.content },
      { role: "user", content: "[System: Your token budget was exhausted. Please continue.]" },
    ];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPromptTooLongError(err: unknown): boolean {
  if (err instanceof Anthropic.BadRequestError) {
    const msg = String(err.message).toLowerCase();
    return msg.includes("prompt is too long") || msg.includes("prompt_too_long");
  }
  return false;
}
