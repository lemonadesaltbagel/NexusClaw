// ---------------------------------------------------------------------------
// Sub-agent configuration — defines agent types, their tool access, and
// system-prompt descriptions for the main agent to know what's available.
// ---------------------------------------------------------------------------

import { toolDefinitions, type ToolDef } from "../tools/definitions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubAgentType = "explore" | "plan" | "general";

export interface SubAgentConfig {
  systemPrompt: string;
  tools: ToolDef[];
}

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
// Built-in agent prompts
// ---------------------------------------------------------------------------

const EXPLORE_PROMPT = `You are an Explore agent — a fast, READ-ONLY sub-agent \
specialized for codebase research and investigation.

Your job:
- Search and read files to answer questions about the codebase
- Find relevant code patterns, definitions, and usages
- Trace through call chains and data flows

IMPORTANT CONSTRAINTS:
- You are READ-ONLY. Do NOT modify any files.
- If using run_shell, only use read commands (ls, cat, find, grep, git log, etc.)
- Do NOT use write, edit, rm, mv, or any destructive shell commands.

Be fast and thorough. Use multiple tool calls when possible.
Return a concise summary of your findings.`;

const PLAN_PROMPT = `You are a Plan agent — a READ-ONLY sub-agent specialized \
for designing implementation plans.

Your job:
- Analyze the codebase to understand the current architecture
- Design a step-by-step implementation plan
- Identify critical files that need modification
- Consider architectural trade-offs

IMPORTANT CONSTRAINTS:
- You are READ-ONLY. Do NOT modify any files.
- If using run_shell, only use read commands (ls, cat, find, grep, git log, etc.)
- Do NOT use write, edit, rm, mv, or any destructive shell commands.

Return a structured plan with:
1. Summary of current state
2. Step-by-step implementation steps
3. Critical files for implementation
4. Potential risks or considerations`;

const GENERAL_PROMPT = `You are a General sub-agent handling an independent task.
Complete the assigned task and return a concise result. You have access to all tools.`;

// ---------------------------------------------------------------------------
// Config lookup
// ---------------------------------------------------------------------------

/** Look up configuration for a given sub-agent type. */
export function getSubAgentConfig(type: SubAgentType): SubAgentConfig {
  switch (type) {
    case "explore":
      return { systemPrompt: EXPLORE_PROMPT, tools: getReadOnlyTools() };
    case "plan":
      return { systemPrompt: PLAN_PROMPT, tools: getReadOnlyTools() };
    case "general":
      return {
        systemPrompt: GENERAL_PROMPT,
        tools: toolDefinitions.filter((t) => t.name !== "agent"),
      };
  }
}

// ---------------------------------------------------------------------------
// Agent descriptions for the system prompt
// ---------------------------------------------------------------------------

const BUILTIN_DESCRIPTIONS: Record<SubAgentType, string> = {
  explore:
    "Read-only exploration agent for codebase research — searches files, " +
    "reads code, and runs non-destructive shell commands.",
  plan:
    "Planning agent that analyzes the codebase and produces a step-by-step plan. " +
    "Read-only — cannot modify files.",
  general:
    "General-purpose sub-agent with full tool access for executing tasks.",
};

/** Build agent descriptions for the system prompt. */
export function buildAgentDescriptions(): string {
  const lines: string[] = [];
  for (const [type, desc] of Object.entries(BUILTIN_DESCRIPTIONS)) {
    lines.push(`- **${type}**: ${desc}`);
  }
  return lines.length > 0
    ? `\n\n# Available sub-agents\n${lines.join("\n")}`
    : "";
}
