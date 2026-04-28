import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  THINKING_MAX_TOKENS,
  MAX_COMPACT_RETRIES,
  MAX_RECOVERY_RETRIES,
  type Message,
  type MessageParam,
  type QueryResult,
  type ThinkingMode,
  type ToolUseBlock,
} from "@/core/types";
import { saveSession, type SessionData } from "@/core/session";

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
  /** Called before a tool is executed. */
  onToolCall?: (name: string, input: Record<string, unknown>) => void;
  /** Called after a tool finishes with its result string. */
  onToolResult?: (name: string, result: string) => void;
  /** Stop hook — return true to *block* the turn from completing. */
  checkStopHook?: (response: Message) => Promise<boolean>;
  /** Extended thinking mode: "disabled" (default), "enabled", or "adaptive". */
  thinkingMode?: ThinkingMode;
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
  private onToolCall: (name: string, input: Record<string, unknown>) => void;
  private onToolResult: (name: string, result: string) => void;
  private checkStopHook?: AgentOptions["checkStopHook"];
  private thinkingMode: ThinkingMode;
  private abortController: AbortController | null = null;
  private sessionId: string = crypto.randomUUID();
  private sessionStartTime: string = new Date().toISOString();

  constructor(options: AgentOptions) {
    this.client = options.client;
    this.model = options.model ?? "claude-sonnet-4-5-20250514";
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.system = options.system;
    this.tools = options.tools;

    this.thinkingMode = options.thinkingMode ?? "disabled";

    this.executeTool =
      options.executeTool ??
      (async (name) => `Tool "${name}" not implemented`);
    this.collapseContext =
      options.collapseContext ?? (async (msgs) => msgs);
    this.compactMessages =
      options.compactMessages ?? (async (msgs) => msgs);
    this.onText = options.onText ?? (() => {});
    this.onToolCall = options.onToolCall ?? (() => {});
    this.onToolResult = options.onToolResult ?? (() => {});
    this.checkStopHook = options.checkStopHook;
  }

  /** Full message history (read-only snapshot). */
  getMessages(): readonly MessageParam[] {
    return this.messages;
  }

  /** Whether the agent is currently processing a turn. */
  get isProcessing(): boolean {
    return this.abortController !== null;
  }

  /** Clear conversation history. */
  clearHistory(): void {
    this.messages = [];
  }

  /** Restore a previously saved session into this agent. */
  restoreSession(data: { messages: MessageParam[] }): void {
    if (data.messages) {
      this.messages = data.messages;
      console.error(`Session restored (${this.getMessageCount()} messages).`);
    }
  }

  /** Number of user messages in the conversation. */
  getMessageCount(): number {
    return this.messages.filter((m) => m.role === "user").length;
  }

  /** The session ID for this agent instance. */
  getSessionId(): string {
    return this.sessionId;
  }

  /** The model name this agent is using. */
  getModel(): string {
    return this.model;
  }

  /** Persist the current session to disk. */
  private autoSave(): void {
    try {
      saveSession(this.sessionId, {
        metadata: {
          id: this.sessionId,
          model: this.model,
          cwd: process.cwd(),
          startTime: this.sessionStartTime,
          messageCount: this.getMessageCount(),
        },
        messages: this.messages,
      });
    } catch {
      // best-effort — don't break the conversation
    }
  }

  /** Display accumulated cost. */
  showCost(): void {
    // TODO: implement cost tracking and display
  }

  /** Compact conversation history to free context space. */
  async compact(): Promise<void> {
    // TODO: implement user-facing compaction
  }

  /** Toggle plan mode on/off. */
  togglePlanMode(): void {
    // TODO: implement plan mode toggle
  }

  /** High-level entry point: runs one full turn with abort support. */
  async chat(userMessage: string): Promise<void> {
    this.abortController = new AbortController();
    try {
      await this.chatAnthropic(userMessage);
    } finally {
      this.abortController = null;
      this.autoSave();
    }
  }

  /** Cancel the in-flight turn (streaming API call + tool execution). */
  abort(): void {
    this.abortController?.abort();
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
        const effectiveMaxTokens =
          this.thinkingMode !== "disabled"
            ? Math.max(currentMaxTokens, THINKING_MAX_TOKENS)
            : currentMaxTokens;

        const createParams: Record<string, unknown> = {
          model: this.model,
          max_tokens: effectiveMaxTokens,
          messages: this.messages,
          ...(this.system !== undefined && { system: this.system }),
          ...(this.tools?.length && { tools: this.tools }),
        };

        if (this.thinkingMode === "enabled") {
          createParams.thinking = { type: "enabled", budget_tokens: effectiveMaxTokens - 1 };
        } else if (this.thinkingMode === "adaptive") {
          createParams.thinking = { type: "enabled", budget_tokens: 10_000 };
        }

        const stream = this.client.messages.stream(createParams as any, {
          signal: this.abortController?.signal,
        });

        stream.on("text", (delta) => this.onText(delta));

        const finalMessage = await stream.finalMessage();

        // When thinking is active, strip thinking blocks from completed turns
        // (no tool_use) to avoid wasting context in subsequent turns.
        // Turns with tool_use must keep thinking blocks — the API requires
        // the signature for validation when tool_result is sent back.
        if (this.thinkingMode !== "disabled") {
          const hasToolUse = finalMessage.content.some(
            (block: any) => block.type === "tool_use",
          );
          if (!hasToolUse) {
            (finalMessage as any).content = finalMessage.content.filter(
              (block: any) => block.type !== "thinking",
            );
          }
        }

        response = finalMessage as Message;
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
      if (this.abortController?.signal.aborted) break;

      const toolInput = block.input as Record<string, unknown>;
      this.onToolCall(block.name, toolInput);

      let content: string;
      try {
        content = await this.executeTool(block.name, toolInput);
      } catch (err) {
        content = `Error executing tool ${block.name}: ${err instanceof Error ? err.message : String(err)}`;
      }

      this.onToolResult(block.name, content);

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
