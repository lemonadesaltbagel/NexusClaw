import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ParsedArgs, PermissionMode } from "@/core/types";
import { Agent } from "@/core/agent";
import type { Provider } from "@/core/provider";
import { AnthropicProvider } from "@/core/providers/anthropic";
import { OpenAIProvider } from "@/core/providers/openai";
import { buildSystemPrompt } from "@/core/prompt";
import { getActiveToolDefinitions, CONCURRENCY_SAFE_TOOLS } from "@/tools/definitions";
import { executeTool, setMcpManager } from "@/tools/executor";
import { McpManager } from "@/core/mcp";
import { runRepl } from "@/cli/repl";
import { getLatestSessionId, loadSession } from "@/core/session";
import { printToolCall, printToolResult, printRetry, printConfirmation, printPlanForApproval, printPlanApprovalOptions } from "@/cli/ui";
import type { PlanApprovalResult } from "@/core/agent";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

function resolveApiKey(apiBase?: string): string | undefined {
  // If a custom base URL is set, prefer OPENAI_API_KEY (OpenAI-compatible)
  if (apiBase) {
    return process.env.OPENAI_API_KEY;
  }
  // Priority: ANTHROPIC_API_KEY → OPENAI_API_KEY
  return process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

function createProvider(apiKey: string, apiBase?: string): Provider {
  if (apiBase) {
    return new OpenAIProvider(new OpenAI({ apiKey, baseURL: apiBase }));
  }
  return new AnthropicProvider(new Anthropic({ apiKey }));
}

// ---------------------------------------------------------------------------
// Chat command
// ---------------------------------------------------------------------------

export const chatCommand = new Command("chat")
  .description("Start an interactive coding agent session")
  .option("-y, --yolo", "Bypass all permission checks")
  .option("--plan", "Plan mode — suggest changes without applying")
  .option("--accept-edits", "Auto-accept file edits, ask for others")
  .option("--dont-ask", "Never prompt, skip tools that need permission")
  .option("--thinking", "Enable extended thinking")
  .option("-m, --model <model>", "Model to use", process.env.MINI_CLAUDE_MODEL || "claude-opus-4-6")
  .option("--api-base <url>", "Custom API base URL")
  .option("--resume", "Resume the previous conversation")
  .option("--max-cost <dollars>", "Maximum spend in USD", parseFloat)
  .option("--max-turns <n>", "Maximum agentic turns", parseInt)
  .argument("[prompt...]", "Initial prompt")
  .action(async (positional: string[], opts) => {
    const permissionMode: PermissionMode = opts.yolo
      ? "bypassPermissions"
      : opts.plan
        ? "plan"
        : opts.acceptEdits
          ? "acceptEdits"
          : opts.dontAsk
            ? "dontAsk"
            : "default";

    const args: ParsedArgs = {
      permissionMode,
      model: opts.model,
      apiBase: opts.apiBase,
      resume: opts.resume ?? false,
      thinking: opts.thinking ?? false,
      maxCost: opts.maxCost,
      maxTurns: opts.maxTurns,
      prompt: positional.length > 0 ? positional.join(" ") : undefined,
    };

    // --- Resolve API key ---
    const apiKey = resolveApiKey(args.apiBase);
    if (!apiKey) {
      console.error("Error: API key is required. Set ANTHROPIC_API_KEY or OPENAI_API_KEY env var.");
      process.exit(1);
    }

    // --- Build provider ---
    const provider = createProvider(apiKey, args.apiBase);

    // --- Build system prompt and tools ---
    const system = buildSystemPrompt();
    const tools = getActiveToolDefinitions();

    // --- Initialize MCP servers ---
    const mcpManager = new McpManager();
    await mcpManager.loadAndConnect();
    if (mcpManager.toolCount > 0) {
      setMcpManager(mcpManager);
      for (const t of mcpManager.getToolDefinitions()) {
        tools.push(t as Omit<import("@/tools/definitions").ToolDef, "deferred">);
      }
    }

    // Clean up MCP connections on exit
    process.on("exit", () => { mcpManager.closeAll(); });
    process.on("SIGINT", () => { mcpManager.closeAll(); });
    process.on("SIGTERM", () => { mcpManager.closeAll(); });

    // --- Create agent ---
    // Don't pass "plan" directly — togglePlanMode() handles plan mode entry
    const initialPermission = args.permissionMode === "plan" ? "default" : args.permissionMode;

    const agent = new Agent({
      provider,
      providerType: args.apiBase ? "openai" : "anthropic",
      model: args.model,
      customSystemPrompt: system,
      customTools: tools,
      executeTool,
      onText: (delta) => process.stdout.write(delta),
      onToolCall: printToolCall,
      onToolResult: printToolResult,
      onRetry: printRetry,
      thinkingMode: args.thinking ? "enabled" : "disabled",
      concurrencySafeTools: CONCURRENCY_SAFE_TOOLS,
      permissionMode: initialPermission,
      confirmDangerous: async (message: string) => {
        printConfirmation(message);
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        return new Promise<boolean>((resolve) => {
          rl.question("  Allow? (y/n): ", (answer) => {
            rl.close();
            resolve(answer.toLowerCase().startsWith("y"));
          });
        });
      },
      planApprovalFn: async (planContent: string): Promise<PlanApprovalResult> => {
        printPlanForApproval(planContent);
        printPlanApprovalOptions();
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        return new Promise<PlanApprovalResult>((resolve) => {
          const askChoice = () => {
            rl.question("  Enter choice (1-4): ", (answer) => {
              const choice = answer.trim();
              if (choice === "1") {
                rl.close();
                resolve({ choice: "clear-and-execute" });
              } else if (choice === "2") {
                rl.close();
                resolve({ choice: "execute" });
              } else if (choice === "3") {
                rl.close();
                resolve({ choice: "manual-execute" });
              } else if (choice === "4") {
                rl.question("  Feedback (what to change): ", (feedback) => {
                  rl.close();
                  resolve({ choice: "keep-planning", feedback: feedback.trim() || undefined });
                });
              } else {
                console.log("  Invalid choice. Enter 1, 2, 3, or 4.");
                askChoice();
              }
            });
          };
          askChoice();
        });
      },
    });

    // --- Initialize plan mode if --plan was passed ---
    if (args.permissionMode === "plan") {
      agent.togglePlanMode();
    }

    // --- Resume previous session if requested ---
    if (args.resume) {
      const sessionId = getLatestSessionId();
      if (sessionId) {
        const session = loadSession(sessionId);
        if (session) agent.restoreSession(session);
      }
    }

    // --- Dispatch ---
    if (args.prompt) {
      // Single-shot mode: execute prompt and exit
      try {
        await agent.chat(args.prompt);
        process.stdout.write("\n");
      } catch (err) {
        console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    } else {
      // REPL mode: interactive loop
      await runRepl(agent);
    }
  });
