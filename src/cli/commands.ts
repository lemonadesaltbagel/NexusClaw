import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { ParsedArgs, PermissionMode } from "@/core/types";
import { Agent } from "@/core/agent";
import { buildSystemPrompt } from "@/core/prompt";
import { getActiveToolDefinitions } from "@/tools/definitions";
import { executeTool } from "@/tools/executor";
import { runRepl } from "@/cli/repl";
import { getLatestSessionId, loadSession } from "@/core/session";
import { printToolCall, printToolResult } from "@/cli/ui";

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

    // --- Build clients ---
    const client = new Anthropic({
      apiKey,
      ...(args.apiBase && { baseURL: args.apiBase }),
    });

    // Create OpenAI client when a custom API base is specified
    const openaiClient = args.apiBase
      ? new OpenAI({ apiKey, baseURL: args.apiBase })
      : undefined;

    // --- Build system prompt and tools ---
    const system = buildSystemPrompt();
    const tools = getActiveToolDefinitions() as Anthropic.Messages.Tool[];

    // --- Create agent ---
    const agent = new Agent({
      client,
      openaiClient,
      model: args.model,
      system,
      tools,
      executeTool,
      onText: (delta) => process.stdout.write(delta),
      onToolCall: printToolCall,
      onToolResult: printToolResult,
      thinkingMode: args.thinking ? "enabled" : "disabled",
    });

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
