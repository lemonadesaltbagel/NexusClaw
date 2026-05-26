// ---------------------------------------------------------------------------
// `nexusclaw serve` — long-running remote-control mode.
//
// Loads ~/.nexusclaw/nexusclaw.json, wires the configured platform
// adapters into the Gateway, and keeps the process alive.
//
// State that changes at runtime (userMap, pairing pending) lives in shared
// mutable maps. File watchers on nexusclaw.json and pairing.json re-hydrate
// these maps so pairing approvals take effect with no restart.
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
import type { PlatformAdapter, RemoteIdentity } from "@/remote/types";
import {
  loadSettings,
  watchSettings,
  appendUserMap,
  DEFAULT_SETTINGS_PATH,
  type NexusClawSettings,
} from "@/remote/settings";
import {
  loadPairing,
  watchPairing,
  addPending,
  DEFAULT_PAIRING_PATH,
} from "@/remote/pairing";
import { TelegramAdapter, type DmAccessProvider } from "@/remote/adapters/telegram";
import { generatePairingCode } from "@/remote/adapters/telegram-dm";

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
// AgentFactory
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
    const latestId = getLatestSessionId();
    if (latestId) {
      const session = loadSession(latestId);
      if (session) agent.restoreSession(session);
    }
    return agent;
  };
}

// ---------------------------------------------------------------------------
// Shared runtime state for the Telegram adapter — the live source of truth
// for userMap and pairing pending. File watchers re-hydrate them.
// ---------------------------------------------------------------------------

interface TelegramState {
  /** telegramUserId → canonicalUserId. */
  knownMap: Map<string, string>;
  /** telegramUserId → pairing code (waiting for approval). */
  pendingByUser: Map<string, string>;
}

function rehydrateKnown(state: TelegramState, settings: NexusClawSettings | null): void {
  state.knownMap.clear();
  if (!settings?.remote.telegram) return;
  for (const [k, v] of Object.entries(settings.remote.telegram.userMap)) {
    state.knownMap.set(k, v);
  }
}

function rehydratePending(state: TelegramState, pairingPath: string): void {
  state.pendingByUser.clear();
  try {
    const p = loadPairing(pairingPath);
    for (const [userId, req] of Object.entries(p.telegram.pending)) {
      state.pendingByUser.set(userId, req.code);
    }
  } catch (err) {
    console.error(`pairing: failed to reload — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fallbackCanonical(userId: string, username?: string): string {
  return username && username.length > 0 ? username : `tg_${userId}`;
}

function buildTelegramDmProvider(
  state: TelegramState,
  settings: NexusClawSettings,
  configPath: string,
  pairingPath: string,
): DmAccessProvider {
  const policy = settings.remote.telegram!.dm.policy;
  return {
    policy,
    isKnown:   (id) => state.knownMap.has(id),
    isPending: (id) => state.pendingByUser.has(id),
    registerPending: (req) => {
      const existing = state.pendingByUser.get(req.userId);
      if (existing) return existing;
      const code = generatePairingCode();
      state.pendingByUser.set(req.userId, code);
      try {
        addPending("telegram", req.userId, {
          code,
          username:    req.username,
          firstName:   req.firstName,
          requestedAt: new Date().toISOString(),
        }, pairingPath);
      } catch (err) {
        console.error(`pairing: failed to persist — ${err instanceof Error ? err.message : String(err)}`);
      }
      return code;
    },
    registerKnown: (req) => {
      if (state.knownMap.has(req.userId)) return;
      const canonical = fallbackCanonical(req.userId, req.username);
      state.knownMap.set(req.userId, canonical);
      try {
        appendUserMap("telegram", req.userId, canonical, configPath);
      } catch (err) {
        console.error(`settings: failed to persist userMap — ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter registration
// ---------------------------------------------------------------------------

function buildAdapters(
  settings: NexusClawSettings | null,
  state: TelegramState,
  configPath: string,
  pairingPath: string,
): PlatformAdapter[] {
  if (!settings) return [];
  const adapters: PlatformAdapter[] = [];
  if (settings.remote.telegram) {
    adapters.push(new TelegramAdapter({
      token: settings.remote.telegram.token,
      verbose: process.env.TELEGRAM_VERBOSE === "1",
      access: { groups: settings.remote.telegram.groups },
      dm: buildTelegramDmProvider(state, settings, configPath, pairingPath),
    }));
  }
  return adapters;
}

// ---------------------------------------------------------------------------
// Serve command
// ---------------------------------------------------------------------------

export const serveCommand = new Command("serve")
  .description("Run NexusClaw as a remote-control server")
  .option("-m, --model <model>", "Model to use", process.env.MINI_CLAUDE_MODEL || "claude-opus-4-6")
  .option("--api-base <url>", "Custom API base URL")
  .option("--config <path>", "Path to nexusclaw.json", DEFAULT_SETTINGS_PATH)
  .option("--pairing-path <path>", "Path to pairing.json", DEFAULT_PAIRING_PATH)
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

    // Live runtime state — populated from disk now, kept in sync by watchers.
    const tgState: TelegramState = { knownMap: new Map(), pendingByUser: new Map() };
    rehydrateKnown(tgState, settings);
    rehydratePending(tgState, opts.pairingPath);

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

    // The gateway resolver consults the live knownMap, not a frozen
    // snapshot, so pairing approvals + open-policy auto-registrations
    // take effect immediately.
    const gateway = new Gateway({
      resolveIdentity: (id: RemoteIdentity): string | null => {
        if (id.platform !== "telegram") return null;
        return tgState.knownMap.get(id.userId) ?? null;
      },
      agentFactory: buildAgentFactory({
        provider,
        providerType: opts.apiBase ? "openai" : "anthropic",
        model: opts.model,
        systemPrompt,
        tools,
      }),
    });

    const adapters = buildAdapters(settings, tgState, opts.config, opts.pairingPath);
    for (const a of adapters) gateway.registerAdapter(a);

    await gateway.start();

    // Hot reload: external edits + the pairing CLI both flow through here.
    const settingsWatcher = watchSettings(() => {
      try {
        const next = loadSettings(opts.config);
        rehydrateKnown(tgState, next);
      } catch (err) {
        console.error(`settings: reload failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }, opts.config);
    const pairingWatcher = watchPairing(() => {
      rehydratePending(tgState, opts.pairingPath);
    }, opts.pairingPath);

    console.log(chalk.bold.cyan("\n  NexusClaw") + chalk.gray(" — remote-control mode"));
    if (adapters.length === 0) {
      console.log(chalk.yellow(`  No platform adapters registered.`));
      console.log(chalk.gray(`  Add credentials under "remote" in ${opts.config}.`));
    } else {
      console.log(chalk.gray(`  Adapters: ${adapters.map((a) => a.name).join(", ")}`));
      if (settings?.remote.telegram) {
        console.log(chalk.gray(`  Telegram DM policy: ${settings.remote.telegram.dm.policy}`));
      }
    }
    console.log(chalk.gray("  Press Ctrl+C to stop.\n"));

    const shutdown = async (): Promise<void> => {
      console.log(chalk.gray("\n  Shutting down…"));
      settingsWatcher.close();
      pairingWatcher.close();
      await gateway.stop();
      mcpManager.closeAll();
      process.exit(0);
    };
    process.on("SIGINT",  () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });

    await new Promise<void>(() => {});
  });
