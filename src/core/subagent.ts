// ---------------------------------------------------------------------------
// Sub-agent configuration — defines agent types, their tool access, and
// system-prompt descriptions for the main agent to know what's available.
// ---------------------------------------------------------------------------

import { toolDefinitions, type ToolDef } from "../tools/definitions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubAgentType = "explore" | "plan" | "general";

// ---------------------------------------------------------------------------
// Read-only tool set — used by "explore" and "plan" agents that should
// never mutate the filesystem or execute arbitrary commands.
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "grep_search",
  "run_shell",
]);

export function getReadOnlyTools(): ToolDef[] {
  return toolDefinitions.filter((t) => READ_ONLY_TOOLS.has(t.name));
}

// ---------------------------------------------------------------------------
// Per-type configuration
// ---------------------------------------------------------------------------

export interface SubAgentConfig {
  type: SubAgentType;
  description: string;
  /** Tools available to this agent type. `undefined` means all tools. */
  tools: ToolDef[] | undefined;
  /** System prompt preamble injected before the main system prompt. */
  systemPrefix: string;
}

const SUBAGENT_CONFIGS: Record<SubAgentType, SubAgentConfig> = {
  explore: {
    type: "explore",
    description:
      "Read-only exploration agent for codebase research — searches files, " +
      "reads code, and runs non-destructive shell commands.",
    tools: getReadOnlyTools(),
    systemPrefix:
      "You are an exploration sub-agent. You can only read and search — " +
      "do NOT attempt to modify any files. Report your findings concisely.",
  },
  plan: {
    type: "plan",
    description:
      "Planning agent that analyzes the codebase and produces a step-by-step plan. " +
      "Read-only — cannot modify files.",
    tools: getReadOnlyTools(),
    systemPrefix:
      "You are a planning sub-agent. Analyze the codebase using read-only tools " +
      "and produce a clear, actionable plan. Do NOT modify any files.",
  },
  general: {
    type: "general",
    description:
      "General-purpose sub-agent with full tool access for executing tasks.",
    tools: undefined,
    systemPrefix:
      "You are a general-purpose sub-agent. Complete the assigned task, " +
      "then report back concisely.",
  },
};

/** Look up configuration for a given sub-agent type. */
export function getSubAgentConfig(type: SubAgentType): SubAgentConfig {
  return SUBAGENT_CONFIGS[type];
}

// ---------------------------------------------------------------------------
// Agent descriptions for the system prompt
// ---------------------------------------------------------------------------

/** Build agent descriptions for the system prompt. */
export function buildAgentDescriptions(): string {
  const lines: string[] = [];
  for (const config of Object.values(SUBAGENT_CONFIGS)) {
    lines.push(`- **${config.type}**: ${config.description}`);
  }
  return lines.length > 0
    ? `\n\n# Available sub-agents\n${lines.join("\n")}`
    : "";
}
