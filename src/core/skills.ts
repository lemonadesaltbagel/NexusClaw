// ---------------------------------------------------------------------------
// Skills system — discover and parse skill definitions from .claude/skills/
// ---------------------------------------------------------------------------
//
// Skills are loaded from two locations (project overrides user):
//   1. ~/.claude/skills/<skill-dir>/  (user-level)
//   2. ./.claude/skills/<skill-dir>/  (project-level)
//
// Each skill directory contains a prompt.md file with YAML frontmatter.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseFrontmatter } from "./memory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  userInvocable: boolean;
  promptTemplate: string;
  source: "project" | "user";
  skillDir: string;
}

// ---------------------------------------------------------------------------
// Skill file parser
// ---------------------------------------------------------------------------

function parseSkillFile(
  filePath: string,
  source: "project" | "user",
  skillDir: string,
): SkillDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const { meta, body } = parseFrontmatter(raw);

  const name = meta.name || skillDir.split("/").pop() || "unknown";
  const userInvocable = meta["user-invocable"] !== "false";

  let allowedTools: string[] | undefined;
  if (meta["allowed-tools"]) {
    const rawTools = meta["allowed-tools"];
    if (rawTools.startsWith("[")) {
      try {
        allowedTools = JSON.parse(rawTools);
      } catch {
        allowedTools = rawTools
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((s) => s.trim());
      }
    } else {
      allowedTools = rawTools.split(",").map((s) => s.trim());
    }
  }

  return {
    name,
    description: meta.description || "",
    whenToUse: meta.when_to_use || meta["when-to-use"],
    allowedTools,
    userInvocable,
    promptTemplate: body,
    source,
    skillDir,
  };
}

// ---------------------------------------------------------------------------
// Load skills from a directory
// ---------------------------------------------------------------------------

function loadSkillsFromDir(
  baseDir: string,
  source: "project" | "user",
  skills: Map<string, SkillDefinition>,
): void {
  if (!existsSync(baseDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const skillDir = join(baseDir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const promptFile = join(skillDir, "prompt.md");
    if (!existsSync(promptFile)) continue;

    const skill = parseSkillFile(promptFile, source, skillDir);
    if (skill) {
      // Map key is the skill name — project-level overwrites user-level
      skills.set(skill.name, skill);
    }
  }
}

// ---------------------------------------------------------------------------
// Skill discovery (cached)
// ---------------------------------------------------------------------------

let cachedSkills: SkillDefinition[] | null = null;

export function discoverSkills(): SkillDefinition[] {
  if (cachedSkills) return cachedSkills;

  const skills = new Map<string, SkillDefinition>();

  // User-level first, then project-level overwrites
  loadSkillsFromDir(join(homedir(), ".claude", "skills"), "user", skills);
  loadSkillsFromDir(join(process.cwd(), ".claude", "skills"), "project", skills);

  cachedSkills = Array.from(skills.values());
  return cachedSkills;
}

/** Clear the cached skills (useful for testing or after skill files change). */
export function clearSkillsCache(): void {
  cachedSkills = null;
}

// ---------------------------------------------------------------------------
// Skill prompt resolution
// ---------------------------------------------------------------------------

/** Resolve a skill's prompt template, substituting arguments and skill dir. */
export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.promptTemplate;
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}

// ---------------------------------------------------------------------------
// Build skill descriptions for the system prompt
// ---------------------------------------------------------------------------

/** Build skill descriptions for the system prompt. */
export function buildSkillDescriptions(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return "";

  const lines: string[] = [];
  for (const skill of skills) {
    let entry = `- ${skill.name}`;
    if (skill.description) entry += `: ${skill.description}`;
    if (skill.whenToUse) entry += ` (${skill.whenToUse})`;
    lines.push(entry);
  }

  return lines.join("\n");
}
