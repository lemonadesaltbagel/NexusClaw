// ---------------------------------------------------------------------------
// `nexuscode serve` — long-running remote-control mode.
//
// Loads ~/.nexusclaw/nexusclaw.json, wires the configured platform
// adapters into the Gateway, and keeps the process alive.
// ---------------------------------------------------------------------------

import { Command } from "commander";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import chalk from "chalk";

import { Agent } from "@/core/agent";
import { AnthropicProvider } from "@/core/providers/anthropic";
import { OpenAIProvider } from "@/core/providers/openai";
import type { Provider } from "@/core/provider";
import { buildSystemPrompt } from "@/core/prompt";
import { getActiveToolDefinitions, CONCURRENCY_SAFE_TOOLS } from "@/tools/definitions";
import { executeTool, setMcpManager } from "@/tools/executor";
import { McpManager } from "@/core/mcp";
import { loadSession, getLatestSessionId } from "@/core/session";

import { Gateway } from "@/remote/gateway";
import type { AgentCallbacks, AgentFactory } from "@/remote/gateway";
import type { PlatformAdapter } from "@/remote/types";
import {
  loadSettings,
  buildIdentityResolver,
  DEFAULT_SETTINGS_PATH,
  type NexusClawSettings,
} from "@/remote/settings";
import { TelegramAdapter } from "@/remote/adapters/telegram";

// ---------------------------------------------------------------------------
// Provider + key resolution (mirrors chatCommand).
// ---------------------------------------------------------------------------

function resolveApiKey(apiBase?: string): string | undefined {
  if (apiBase) return process.env.OPENAI_API_KEY;
  return process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
}

function createProvider(apiKey: string, apiBase?: string): Provider {
  if (apiBase) return new OpenAIProvider(new OpenAI({ apiKey, baseURL: apiBase }));
  return new AnthropicProvider(new Anthropic({ apiKey }));
}

// ---------------------------------------------------------------------------
// AgentFactory — provider, MCP, tools, system prompt are built once at
// startup; each canonical user gets a fresh Agent with their own callbacks
// and (where present) restored session.
// ---------------------------------------------------------------------------

interface FactoryEnv {
  provider: Provider;
  providerType: "anthropic" | "openai";
  model: string;
  systemPrompt: ReturnType<typeof buildSystemPrompt>;
  tools: ReturnType<typeof getActiveToolDefinitions>;
}

function buildAgentFactory(env: FactoryEnv): AgentFactory {
  return async (_canonicalUserId, cb: AgentCallbacks): Promise<Agent> => {
    const agent = new Agent({
      provider: env.provider,
      providerType: env.providerType,
      model: env.model,
      customSystemPrompt: env.systemPrompt,
      customTools: env.tools,
      executeTool,
      concurrencySafeTools: CONCURRENCY_SAFE_TOOLS,
      onText: cb.onText,
      onToolCall: cb.onToolCall,
      onToolResult: cb.onToolResult,
      confirmDangerous: cb.confirmDangerous,
      planApprovalFn: cb.planApprovalFn,
    });

    // Best-effort session restore. Per-user session namespacing is deferred:
    // for now any remote user inherits the latest CLI session if one exists.
    const latestId = getLatestSessionId();
    if (latestId) {
      const session = loadSession(latestId);
      if (session) agent.restoreSession(session);
    }

    return agent;
  };
}

// ---------------------------------------------------------------------------
// Adapter registration — read settings and instantiate every enabled
// adapter. New platforms only need a branch here.
// ---------------------------------------------------------------------------

function buildAdapters(settings: NexusClawSettings | null): PlatformAdapter[] {
  if (!settings) return [];
  const adapters: PlatformAdapter[] = [];
  if (settings.remote.telegram) {
    adapters.push(new TelegramAdapter({ token: settings.remote.telegram.token }));
  }
  return adapters;
}

// ---------------------------------------------------------------------------
// Serve command
// ---------------------------------------------------------------------------

export const serveCommand = new Command("serve")
  .description("Run NexusCode as a remote-control server")
  .option("-m, --model <model>", "Model to use", process.env.MINI_CLAUDE_MODEL || "claude-opus-4-6")
  .option("--api-base <url>", "Custom API base URL")
  .option("--config <path>", "Path to nexusclaw.json", DEFAULT_SETTINGS_PATH)
  .action(async (opts) => {
    const apiKey = resolveApiKey(opts.apiBase);
    if (!apiKey) {
      console.error("Error: API key is required. Set ANTHROPIC_API_KEY or OPENAI_API_KEY env var.");
      process.exit(1);
    }

    let settings: NexusClawSettings | null;
    try {
      settings = loadSettings(opts.config);
    } catch (err) {
      console.error(`Error: failed to load settings from ${opts.config}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const provider = createProvider(apiKey, opts.apiBase);
    const systemPrompt = buildSystemPrompt();
    const tools = getActiveToolDefinitions();

    const mcpManager = new McpManager();
    await mcpManager.loadAndConnect();
    if (mcpManager.toolCount > 0) {
      setMcpManager(mcpManager);
      for (const t of mcpManager.getToolDefinitions()) {
        tools.push(t as Omit<import("@/tools/definitions").ToolDef, "deferred">);
      }
    }

    const gateway = new Gateway({
      resolveIdentity: buildIdentityResolver(settings),
      agentFactory: buildAgentFactory({
        provider,
        providerType: opts.apiBase ? "openai" : "anthropic",
        model: opts.model,
        systemPrompt,
        tools,
      }),
    });

    const adapters = buildAdapters(settings);
    for (const a of adapters) gateway.registerAdapter(a);

    await gateway.start();

    console.log(chalk.bold.cyan("\n  NexusClaw") + chalk.gray(" — remote-control mode"));
    if (adapters.length === 0) {
      console.log(chalk.yellow(`  No platform adapters registered.`));
      console.log(chalk.gray(`  Add credentials under "remote" in ${opts.config}.`));
    } else {
      console.log(chalk.gray(`  Adapters: ${adapters.map((a) => a.name).join(", ")}`));
    }
    console.log(chalk.gray("  Press Ctrl+C to stop.\n"));

    const shutdown = async (): Promise<void> => {
      console.log(chalk.gray("\n  Shutting down…"));
      await gateway.stop();
      mcpManager.closeAll();
      process.exit(0);
    };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });

    // Keep the process alive even when no adapters are registered.
    await new Promise<void>(() => {});
  });
