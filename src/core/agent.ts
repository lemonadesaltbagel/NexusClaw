import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_COMPACT_RETRIES,
  MAX_RECOVERY_RETRIES,
  type Message,
  type MessageParam,
  type PermissionMode,
  type PermissionResult,
  type QueryResult,
  type ThinkingMode,
  type ToolUseBlock,
} from "@/core/types";
import { checkPermission } from "@/tools/dangerous";
import { saveSession } from "@/core/session";
import {
  startMemoryPrefetch,
  formatMemoriesForInjection,
  type MemoryPrefetch,
  type SideQueryFn,
} from "@/core/memory";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Provider } from "@/core/provider";
import { isPromptTooLongError } from "@/core/providers/anthropic";
import { withRetry } from "@/core/retry";

const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const KEEP_RECENT_RESULTS = 3;
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Agent — single-class orchestrator for a conversational coding agent.
//
// Manages the full conversation lifecycle: API calls, message history, tool
// dispatch, context compaction, and token-limit recovery. The Agent is
// provider-agnostic — it delegates all API communication to a Provider.
// ---------------------------------------------------------------------------

export interface PlanApprovalResult {
  choice: "execute" | "clear-and-execute" | "manual-execute" | "keep-planning";
  feedback?: string;
}

export interface AgentOptions {
  provider: Provider;
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
  /** Called when a transient API error triggers a retry. */
  onRetry?: (attempt: number, maxRetries: number, reason: string) => void;
  /** Stop hook — return true to *block* the turn from completing. */
  checkStopHook?: (response: Message) => Promise<boolean>;
  /** Extended thinking mode: "disabled" (default), "enabled", or "adaptive". */
  thinkingMode?: ThinkingMode;
  /** Set of tool names that are safe to execute concurrently during streaming. */
  concurrencySafeTools?: Set<string>;
  /** Check whether a tool invocation is permitted without user interaction. */
  checkPermission?: (
    name: string,
    input: Record<string, unknown>,
  ) => PermissionResult;
  /** Permission mode controlling tool access. */
  permissionMode?: PermissionMode;
  /** Path to the plan file (edits allowed in plan mode). */
  planFilePath?: string;
  /** Prompt the user to confirm a dangerous action. Returns true if confirmed. */
  confirmDangerous?: (message: string) => Promise<boolean>;
  /** Prompt the user to approve/reject a plan when exit_plan_mode is called. */
  planApprovalFn?: (planContent: string) => Promise<PlanApprovalResult>;
  /** Provider type — affects compaction strategy (OpenAI has system as a message). */
  providerType?: "anthropic" | "openai";
  /** Whether this agent is a sub-agent (disables memory prefetch). */
  isSubAgent?: boolean;
}

export class Agent {
  private provider: Provider;
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
  private onRetry: (attempt: number, maxRetries: number, reason: string) => void;
  private checkStopHook?: AgentOptions["checkStopHook"];
  private thinkingMode: ThinkingMode;
  private concurrencySafeTools: Set<string>;
  private checkPermission?: AgentOptions["checkPermission"];
  private permissionMode: PermissionMode;
  private planFilePath?: string;
  private confirmDangerous: (message: string) => Promise<boolean>;
  private planApprovalFn?: (planContent: string) => Promise<PlanApprovalResult>;
  private providerType: "anthropic" | "openai";
  private confirmedPaths: Set<string> = new Set();
  private prePlanMode: PermissionMode | null = null;
  private baseSystemPrompt: string | Anthropic.Messages.TextBlockParam[] | undefined;
  private contextCleared: boolean = false;
  private abortController: AbortController | null = null;
  private sessionId: string = crypto.randomUUID();
  private sessionStartTime: string = new Date().toISOString();
  private lastInputTokenCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private effectiveWindow = 200_000;
  private lastApiCallTime: number | null = null;
  private isSubAgent: boolean;
  private alreadySurfacedMemories = new Set<string>();
  private sessionMemoryBytes = 0;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.model = options.model ?? "claude-sonnet-4-5-20250514";
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.system = options.system;
    this.baseSystemPrompt = options.system;
    this.tools = options.tools;

    this.thinkingMode = options.thinkingMode ?? "disabled";
    this.concurrencySafeTools = options.concurrencySafeTools ?? new Set();
    this.checkPermission = options.checkPermission;
    this.permissionMode = options.permissionMode ?? "default";
    this.planFilePath = options.planFilePath;
    this.providerType = options.providerType ?? "anthropic";
    this.isSubAgent = options.isSubAgent ?? false;
    this.confirmDangerous =
      options.confirmDangerous ?? (async () => false);
    this.planApprovalFn = options.planApprovalFn;

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
    this.onRetry = options.onRetry ?? (() => {});
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

  /** Set the plan approval callback (for deferred setup after construction). */
  setPlanApprovalFn(fn: (planContent: string) => Promise<PlanApprovalResult>): void {
    this.planApprovalFn = fn;
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

  /** Display accumulated token usage. */
  showCost(): void {
    const totalTokens = this.totalInputTokens + this.totalOutputTokens;
    console.log(
      `  ℹ Token usage — input: ${this.totalInputTokens.toLocaleString()}, ` +
        `output: ${this.totalOutputTokens.toLocaleString()}, ` +
        `total: ${totalTokens.toLocaleString()}`,
    );
  }

  /** Compact conversation history to free context space. */
  async compact(): Promise<void> {
    await this.compactConversation();
    console.log("  ℹ Conversation compacted.");
  }

  /** Toggle plan mode on/off. */
  togglePlanMode(): string {
    if (this.permissionMode === "plan") {
      // Exit: restore original mode, clean up state, remove plan prompt
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = undefined;
      this.system = this.baseSystemPrompt;
      console.error(`  ℹ Exited plan mode → ${this.permissionMode} mode`);
      return this.permissionMode;
    } else {
      // Enter: save current mode, switch permission, generate plan file, inject prompt
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.system = this.buildPlanModePrompt();
      console.error(`  ℹ Entered plan mode. Plan file: ${this.planFilePath}`);
      return "plan";
    }
  }

  /** Generate a session-scoped plan file path under ~/.claude/plans/. */
  private generatePlanFilePath(): string {
    const dir = join(homedir(), ".claude", "plans");
    mkdirSync(dir, { recursive: true });
    return join(dir, `plan-${this.sessionId}.md`);
  }

  /** Build the system prompt with plan mode instructions appended. */
  private buildPlanModePrompt(): string | Anthropic.Messages.TextBlockParam[] {
    const planInstructions = `

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below),
run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file.
This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode.
Do NOT ask the user to approve — exit_plan_mode handles that.`;

    const base = this.baseSystemPrompt;
    if (typeof base === "string") {
      return base + planInstructions;
    }
    if (Array.isArray(base)) {
      return [
        ...base,
        { type: "text" as const, text: planInstructions },
      ];
    }
    return planInstructions;
  }

  /** Clear message history while preserving the system prompt. */
  private clearHistoryKeepSystem(): void {
    this.messages = [];
  }

  /** Execute plan mode tool calls (enter_plan_mode / exit_plan_mode). */
  private async executePlanModeTool(name: string): Promise<string> {
    if (name === "enter_plan_mode") {
      if (this.permissionMode === "plan") {
        return "Already in plan mode.";
      }
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.system = this.buildPlanModePrompt();
      console.error("  ℹ Entered plan mode (read-only). Plan file: " + this.planFilePath);
      return `Entered plan mode. You are now in read-only mode.\n\n` +
        `Your plan file: ${this.planFilePath}\n` +
        `Write your plan to this file. This is the only file you can edit.\n\n` +
        `When your plan is complete, call exit_plan_mode.`;
    }

    if (name === "exit_plan_mode") {
      if (this.permissionMode !== "plan") {
        return "Not in plan mode.";
      }
      // Read plan file contents
      let planContent = "(No plan file found)";
      if (this.planFilePath && existsSync(this.planFilePath)) {
        planContent = readFileSync(this.planFilePath, "utf-8");
      }

      // Interactive approval workflow
      if (this.planApprovalFn) {
        const result = await this.planApprovalFn(planContent);

        if (result.choice === "keep-planning") {
          // User rejected — stay in plan mode, return feedback to model
          const feedback = result.feedback || "Please revise the plan.";
          return `User rejected the plan and wants to keep planning.\n\n` +
            `User feedback: ${feedback}\n\n` +
            `Please revise your plan based on this feedback. When done, call exit_plan_mode again.`;
        }

        // User approved — determine target permission mode
        let targetMode: PermissionMode;
        if (result.choice === "clear-and-execute" || result.choice === "execute") {
          targetMode = "acceptEdits";
        } else {
          targetMode = this.prePlanMode || "default"; // manual-execute: restore original mode
        }

        // Exit plan mode
        this.permissionMode = targetMode;
        this.prePlanMode = null;
        const savedPlanPath = this.planFilePath;
        this.planFilePath = undefined;
        this.system = this.baseSystemPrompt;

        // Clear context (if clear-and-execute was chosen)
        if (result.choice === "clear-and-execute") {
          this.clearHistoryKeepSystem();
          this.contextCleared = true;
          console.error(`  ℹ Plan approved. Context cleared, executing in ${targetMode} mode.`);
          return `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\n` +
            `Plan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
        }

        console.error(`  ℹ Plan approved. Executing in ${targetMode} mode.`);
        return `User approved the plan. Permission mode: ${targetMode}\n\n` +
          `## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
      }

      // Fallback: exit directly when no approval function exists (e.g., sub-agent)
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = undefined;
      this.system = this.baseSystemPrompt;
      console.error("  ℹ Exited plan mode. Restored to " + this.permissionMode + " mode.");
      return `Exited plan mode. Permission mode restored to: ${this.permissionMode}\n\n` +
        `## Your Plan:\n${planContent}`;
    }

    return `Unknown plan mode tool: ${name}`;
  }

  /** High-level entry point: runs one full turn with abort support. */
  async chat(userMessage: string): Promise<QueryResult> {
    this.abortController = new AbortController();
    try {
      return await this.runTurn(userMessage);
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
  // Side query — lightweight LLM call for memory selection
  // -----------------------------------------------------------------------

  /** Build a side-query function using the current provider. */
  private buildSideQuery(): SideQueryFn | null {
    return async (system: string, userMessage: string, signal?: AbortSignal) => {
      const resp = await this.provider.createMessage({
        model: this.model,
        maxTokens: 1024,
        messages: [{ role: "user", content: userMessage }],
        system,
        thinkingMode: "disabled",
        signal,
      });
      const block = resp.content[0];
      return block?.type === "text" ? block.text : "";
    };
  }

  // -----------------------------------------------------------------------
  // runTurn — core method driving one full user→assistant turn.
  // Provider-agnostic: delegates streaming to this.provider.
  // -----------------------------------------------------------------------

  private async runTurn(userMessage: string): Promise<QueryResult> {
    this.messages.push({ role: "user", content: userMessage });

    // Start memory prefetch (non-blocking, runs in parallel with API call)
    let memoryPrefetch: MemoryPrefetch | null = null;
    if (!this.isSubAgent) {
      const sq = this.buildSideQuery();
      if (sq) {
        memoryPrefetch = startMemoryPrefetch(
          userMessage, sq,
          this.alreadySurfacedMemories, this.sessionMemoryBytes,
          this.abortController?.signal,
        );
      }
    }

    let currentMaxTokens = this.maxTokens;
    let hasEscalated = false;
    let recoveryRetries = 0;
    let collapseAttempted = false;
    let compactRetries = 0;
    let withheldError: unknown = null;

    while (true) {
      // ----- Non-blocking memory prefetch poll -----
      if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
        memoryPrefetch.consumed = true;
        const memories = await memoryPrefetch.promise;
        if (memories.length > 0) {
          const injectionText = formatMemoriesForInjection(memories);
          this.messages.push({ role: "user", content: injectionText });
          for (const m of memories) {
            this.alreadySurfacedMemories.add(m.path);
            this.sessionMemoryBytes += Buffer.byteLength(m.content);
          }
        }
      }

      // ----- Compression pipeline (Tier 1 → 2 → 3) -----
      this.budgetToolResults();    // Tier 1: tighten oversized results
      this.snipStaleResults();     // Tier 2: snip redundant/stale results
      this.microcompact();         // Tier 3: clear old results after idle

      // ----- API call -----
      let response: Message;

      // Track tools executed early during streaming
      const earlyExecutions = new Map<string, Promise<string>>();

      try {
        response = await withRetry(
          (signal) =>
            this.provider.createMessage({
              model: this.model,
              maxTokens: currentMaxTokens,
              messages: this.messages,
              system: this.system,
              tools: this.tools,
              thinkingMode: this.thinkingMode,
              signal,
              onText: (delta) => this.onText(delta),
              onToolUse: (block) => {
                if (this.concurrencySafeTools.has(block.name)) {
                  const perm = this.checkPermission?.(block.name, block.input);
                  if (!perm || perm.behavior === "allow") {
                    earlyExecutions.set(
                      block.id,
                      this.executeTool(block.name, block.input),
                    );
                  }
                }
              },
            }),
          this.abortController?.signal,
          3,
          this.onRetry,
        );
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

      // Track token usage for context pressure budgeting and cost estimation
      this.lastInputTokenCount = response.usage?.input_tokens ?? 0;
      this.totalInputTokens += response.usage?.input_tokens ?? 0;
      this.totalOutputTokens += response.usage?.output_tokens ?? 0;
      this.lastApiCallTime = Date.now();

      // ----- Auto-compact if context window is nearly full -----
      await this.checkAndCompact();

      // ----- Dispatch on stop_reason -----
      switch (response.stop_reason) {
        // ---- tool_use: model wants to use a tool ----
        case "tool_use": {
          await this.handleNextTurn(response, earlyExecutions);
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

  /** Execute tools, append assistant message + tool results. Uses early executions when available. */
  private async handleNextTurn(
    response: Message,
    earlyExecutions: Map<string, Promise<string>>,
  ): Promise<void> {
    const toolBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    // Pre-check each tool block for concurrency eligibility
    type CheckedBlock = {
      block: ToolUseBlock;
      input: Record<string, unknown>;
      concurrent: boolean;
    };
    const checked: CheckedBlock[] = toolBlocks.map((block) => {
      const input = block.input as Record<string, unknown>;
      const isSafe = this.concurrencySafeTools.has(block.name);
      const perm = this.checkPermission?.(block.name, input);
      const allowed = !perm || perm.behavior === "allow";
      return { block, input, concurrent: isSafe && allowed };
    });

    // Group consecutive concurrency-safe tools into batches
    type Batch = { concurrent: boolean; items: CheckedBlock[] };
    const batches: Batch[] = [];
    for (const cb of checked) {
      if (
        cb.concurrent &&
        batches.length > 0 &&
        batches[batches.length - 1].concurrent
      ) {
        batches[batches.length - 1].items.push(cb);
      } else {
        batches.push({ concurrent: cb.concurrent, items: [cb] });
      }
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const batch of batches) {
      if (this.abortController?.signal.aborted) break;

      if (batch.concurrent) {
        // Execute concurrency-safe batch in parallel
        const results = await Promise.all(
          batch.items.map(async ({ block, input }) => {
            this.onToolCall(block.name, input);
            let content: string;
            try {
              const earlyPromise = earlyExecutions.get(block.id);
              content = earlyPromise
                ? await earlyPromise
                : await this.executeTool(block.name, input);
            } catch (err) {
              content = `Error executing tool ${block.name}: ${err instanceof Error ? err.message : String(err)}`;
            }
            content = this.persistLargeResult(block.name, content);
            this.onToolResult(block.name, content);
            return { block, content };
          }),
        );
        for (const { block, content } of results) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content,
          });
        }
      } else {
        // Non-safe tools execute sequentially with permission checks
        for (const { block, input } of batch.items) {
          if (this.abortController?.signal.aborted) break;

          const perm = checkPermission(
            block.name,
            input as Record<string, any>,
            this.permissionMode,
            this.planFilePath,
          );

          if (perm.action === "deny") {
            console.error(`Denied: ${perm.message}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Action denied: ${perm.message}`,
            });
            continue;
          }

          if (
            perm.action === "confirm" &&
            perm.message &&
            !this.confirmedPaths.has(perm.message)
          ) {
            const confirmed = await this.confirmDangerous(perm.message);
            if (!confirmed) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: "User denied this action.",
              });
              continue;
            }
            this.confirmedPaths.add(perm.message);
          }

          this.onToolCall(block.name, input);
          let content: string;
          try {
            if (block.name === "enter_plan_mode" || block.name === "exit_plan_mode") {
              content = await this.executePlanModeTool(block.name);
            } else {
              const earlyPromise = earlyExecutions.get(block.id);
              content = earlyPromise
                ? await earlyPromise
                : await this.executeTool(block.name, input);
            }
          } catch (err) {
            content = `Error executing tool ${block.name}: ${err instanceof Error ? err.message : String(err)}`;
          }
          content = this.persistLargeResult(block.name, content);
          this.onToolResult(block.name, content);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content,
          });
        }
      }
    }

    this.messages = [
      ...this.messages,
      { role: "assistant", content: response.content },
      { role: "user", content: toolResults },
    ];
  }

  /** Persist large tool results to disk and return a truncated preview. */
  private persistLargeResult(toolName: string, result: string): string {
    const THRESHOLD = 30 * 1024; // 30 KB
    if (Buffer.byteLength(result) <= THRESHOLD) return result;

    const dir = join(homedir(), ".mini-claude", "tool-results");
    mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-${toolName}.txt`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, result);

    const lines = result.split("\n");
    const preview = lines.slice(0, 200).join("\n");
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    return `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`;
  }

  /** Dynamically tighten tool results in history based on context pressure. */
  private budgetToolResults(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;

    const budget = utilization > 0.7 ? 15_000 : 30_000;

    for (const msg of this.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i] as any;
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > budget
        ) {
          const keepEach = Math.floor((budget - 80) / 2);
          block.content =
            block.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
            block.content.slice(-keepEach);
        }
      }
    }
  }

  /**
   * Snip stale tool results when context pressure exceeds 60%.
   *
   * - read_file: if the same file was read multiple times, keep only the latest.
   * - grep_search / list_files / run_shell: keep the 3 most recent per type.
   * - The 3 most recent tool_result entries (any type) are always preserved.
   *
   * Only tool_result content is replaced; the corresponding tool_use block
   * stays intact so the model retains metadata about what it did.
   */
  private snipStaleResults(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization <= 0.6) return;

    // Build tool_use_id → { name, input } from assistant messages
    const toolUseMap = new Map<
      string,
      { name: string; input: Record<string, unknown> }
    >();
    for (const msg of this.messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as any;
        if (b.type === "tool_use") {
          toolUseMap.set(b.id, { name: b.name, input: b.input ?? {} });
        }
      }
    }

    // Collect every tool_result block in message order (mutable refs)
    type ResultRef = {
      block: any;
      toolName: string;
      input: Record<string, unknown>;
    };
    const allResults: ResultRef[] = [];
    for (const msg of this.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as any;
        if (b.type === "tool_result") {
          const meta = toolUseMap.get(b.tool_use_id);
          allResults.push({
            block: b,
            toolName: meta?.name ?? "",
            input: meta?.input ?? {},
          });
        }
      }
    }

    // The N most recent tool_result entries are unconditionally protected
    const protectedSet = new Set(allResults.slice(-KEEP_RECENT_RESULTS));

    // ---- read_file dedup: keep only the latest read per file_path ----
    // Find the latest read per path across ALL entries (including protected)
    const latestReadByPath = new Map<string, ResultRef>();
    for (const r of allResults) {
      if (r.toolName === "read_file") {
        latestReadByPath.set((r.input.file_path as string) ?? "", r);
      }
    }

    // ---- search tools: count per type to enforce the cap ----
    // Count backwards so we can identify which to keep
    const searchKeepCount = new Map<string, number>();

    // Walk in reverse to mark the first KEEP_RECENT_RESULTS per type as kept
    const searchKept = new Set<ResultRef>();
    for (let i = allResults.length - 1; i >= 0; i--) {
      const r = allResults[i];
      if (r.toolName === "read_file" || !SNIPPABLE_TOOLS.has(r.toolName))
        continue;
      const count = searchKeepCount.get(r.toolName) ?? 0;
      if (count < KEEP_RECENT_RESULTS) {
        searchKept.add(r);
        searchKeepCount.set(r.toolName, count + 1);
      }
    }

    // ---- Apply snips ----
    for (const r of allResults) {
      if (protectedSet.has(r)) continue;
      if (!SNIPPABLE_TOOLS.has(r.toolName)) continue;
      if (typeof r.block.content !== "string") continue;
      if (r.block.content === SNIP_PLACEHOLDER) continue;

      let shouldSnip = false;

      if (r.toolName === "read_file") {
        const path = (r.input.file_path as string) ?? "";
        shouldSnip = latestReadByPath.get(path) !== r;
      } else {
        shouldSnip = !searchKept.has(r);
      }

      if (shouldSnip) {
        r.block.content = SNIP_PLACEHOLDER;
      }
    }
  }

  /** Clear old tool_result content after an idle period (≥5 min since last API call).
   *  Keeps the most recent KEEP_RECENT_RESULTS entries intact. */
  private microcompact(): void {
    if (
      !this.lastApiCallTime ||
      Date.now() - this.lastApiCallTime < MICROCOMPACT_IDLE_MS
    ) {
      return;
    }

    // Collect all tool_result blocks in message order
    const allResults: any[] = [];
    for (const msg of this.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as any;
        if (b.type === "tool_result" && typeof b.content === "string") {
          allResults.push(b);
        }
      }
    }

    // Protect the most recent entries
    const protectedSet = new Set(allResults.slice(-KEEP_RECENT_RESULTS));

    for (const block of allResults) {
      if (!protectedSet.has(block)) {
        block.content = "[Old result cleared]";
      }
    }
  }

  /** Trigger compaction when context utilization exceeds 85%. */
  private async checkAndCompact(): Promise<void> {
    if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
      console.error("Context window filling up, compacting conversation...");
      await this.compactConversation();
    }
  }

  /** Summarize all but the last user message, replacing history with a compact summary. */
  private async compactConversation(): Promise<void> {
    if (this.providerType === "openai") {
      return this.compactOpenAI();
    }
    return this.compactAnthropic();
  }

  /** Compact for Anthropic — system prompt is separate from messages. */
  private async compactAnthropic(): Promise<void> {
    if (this.messages.length < 4) return;

    const lastUserMsg = this.messages[this.messages.length - 1];

    const summaryResp = await this.provider.createMessage({
      model: this.model,
      maxTokens: 2048,
      messages: [
        ...this.messages.slice(0, -1),
        {
          role: "user",
          content:
            "Summarize the conversation so far in a concise paragraph, " +
            "preserving key decisions, file paths, and context needed to continue the work.",
        },
      ],
      system:
        "You are a conversation summarizer. Be concise but preserve important details.",
      thinkingMode: "disabled",
    });

    const summaryText =
      summaryResp.content[0]?.type === "text"
        ? summaryResp.content[0].text
        : "No summary available.";

    this.messages = [
      {
        role: "user",
        content: `[Previous conversation summary]\n${summaryText}`,
      },
      {
        role: "assistant",
        content:
          "Understood. I have the context from our previous conversation. " +
          "How can I continue helping?",
      },
    ];

    if (lastUserMsg.role === "user") {
      this.messages.push(lastUserMsg);
    }

    this.lastInputTokenCount = 0;
  }

  /**
   * Compact for OpenAI — system prompt occupies a message slot so the
   * minimum threshold is higher (system + 4 conversation messages = 5).
   * The original system prompt is preserved through compaction.
   */
  private async compactOpenAI(): Promise<void> {
    // OpenAI: system takes a slot, so need at least 5 effective messages
    // (system + 4 conversation) to have enough to compact.
    if (this.messages.length < 4) return;

    const lastUserMsg = this.messages[this.messages.length - 1];

    // Summary call — override system with summarizer instruction while
    // the conversation body (minus last msg) is sent for summarization.
    const summaryResp = await this.provider.createMessage({
      model: this.model,
      maxTokens: 2048,
      messages: [
        ...this.messages.slice(0, -1),
        {
          role: "user",
          content:
            "Summarize the conversation so far in a concise paragraph, " +
            "preserving key decisions, file paths, and context needed to continue the work.",
        },
      ],
      system:
        "You are a conversation summarizer. Be concise but preserve important details.",
      thinkingMode: "disabled",
    });

    const summaryText =
      summaryResp.content[0]?.type === "text"
        ? summaryResp.content[0].text
        : "No summary available.";

    // Reset messages — the original this.system is preserved separately
    // and will be re-prepended by the OpenAI provider on the next call.
    this.messages = [
      {
        role: "user",
        content: `[Previous conversation summary]\n${summaryText}`,
      },
      {
        role: "assistant",
        content:
          "Understood. I have the context from our previous conversation. " +
          "How can I continue helping?",
      },
    ];

    if (lastUserMsg.role === "user") {
      this.messages.push(lastUserMsg);
    }

    this.lastInputTokenCount = 0;
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
