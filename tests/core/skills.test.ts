import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import * as os from "os";
import {
  discoverSkills,
  clearSkillsCache,
  resolveSkillPrompt,
  getSkillByName,
  executeSkill,
  buildSkillDescriptions,
} from "../../src/core/skills.js";
import type { SkillDefinition } from "../../src/core/skills.js";

// ---------------------------------------------------------------------------
// Helpers — create a temp skills directory tree
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalCwd: string;

function writeSkill(
  base: string,
  dirName: string,
  content: string,
): void {
  const skillDir = join(base, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "prompt.md"), content);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(os.tmpdir(), "skills-test-"));
  originalCwd = process.cwd();
  clearSkillsCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  clearSkillsCache();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// discoverSkills — loading from project directory
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  test("discovers skills from project .claude/skills/", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "greet", `---
name: greet
description: Say hello
---

Hello $ARGUMENTS!`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const greet = skills.find((s) => s.name === "greet");
    expect(greet).toBeDefined();
    expect(greet!.description).toBe("Say hello");
    expect(greet!.source).toBe("project");
    expect(greet!.userInvocable).toBe(true);
    expect(greet!.promptTemplate).toBe("Hello $ARGUMENTS!");
  });

  test("returns empty array when no skills directory exists", () => {
    process.chdir(tmpDir);
    const skills = discoverSkills();
    // May include user-level skills from ~/.claude/skills/ if they exist,
    // but at minimum should not throw
    expect(Array.isArray(skills)).toBe(true);
  });

  test("skips directories without prompt.md", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    const emptySkill = join(skillsDir, "no-prompt");
    mkdirSync(emptySkill, { recursive: true });
    writeFileSync(join(emptySkill, "readme.md"), "not a skill");

    process.chdir(tmpDir);
    const skills = discoverSkills();
    expect(skills.find((s) => s.name === "no-prompt")).toBeUndefined();
  });

  test("caches results and clearSkillsCache resets", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "alpha", `---
name: alpha
description: first
---

body`);

    process.chdir(tmpDir);
    const first = discoverSkills();
    const second = discoverSkills();
    expect(first).toBe(second); // same reference = cached

    clearSkillsCache();
    const third = discoverSkills();
    expect(third).not.toBe(first); // new reference after cache clear
  });

  test("project-level skills override user-level skills with same name", () => {
    // Simulate by creating two skill dirs and loading sequentially
    const userDir = join(tmpDir, "user-skills");
    const projDir = join(tmpDir, ".claude", "skills");

    writeSkill(userDir, "deploy", `---
name: deploy
description: user deploy
---

user version`);

    writeSkill(projDir, "deploy", `---
name: deploy
description: project deploy
---

project version`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    const deploy = skills.find((s) => s.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy!.description).toBe("project deploy");
    expect(deploy!.source).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// Skill file parsing — frontmatter fields
// ---------------------------------------------------------------------------

describe("skill parsing", () => {
  test("parses all frontmatter fields", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "lint", `---
name: lint
description: Run linter
when-to-use: when code quality is needed
user-invocable: false
allowed-tools: read_file, run_shell
---

Run the linter on $ARGUMENTS`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    const lint = skills.find((s) => s.name === "lint");
    expect(lint).toBeDefined();
    expect(lint!.description).toBe("Run linter");
    expect(lint!.whenToUse).toBe("when code quality is needed");
    expect(lint!.userInvocable).toBe(false);
    expect(lint!.allowedTools).toEqual(["read_file", "run_shell"]);
    expect(lint!.promptTemplate).toBe("Run the linter on $ARGUMENTS");
  });

  test("falls back to directory name when no name in frontmatter", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "fallback-name", `---
description: no name field
---

body`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    const skill = skills.find((s) => s.name === "fallback-name");
    expect(skill).toBeDefined();
  });

  test("parses allowed-tools as JSON array", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "json-tools", `---
name: json-tools
description: test
allowed-tools: ["read_file", "write_file"]
---

body`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    const skill = skills.find((s) => s.name === "json-tools");
    expect(skill!.allowedTools).toEqual(["read_file", "write_file"]);
  });

  test("parses allowed-tools as bracket-wrapped non-JSON", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "bracket-tools", `---
name: bracket-tools
description: test
allowed-tools: [read_file, write_file]
---

body`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    const skill = skills.find((s) => s.name === "bracket-tools");
    expect(skill!.allowedTools).toEqual(["read_file", "write_file"]);
  });

  test("defaults userInvocable to true", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "default-invocable", `---
name: default-invocable
description: test
---

body`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    const skill = skills.find((s) => s.name === "default-invocable");
    expect(skill!.userInvocable).toBe(true);
  });

  test("supports when_to_use (underscore variant)", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "underscore-when", `---
name: underscore-when
description: test
when_to_use: when testing underscores
---

body`);

    process.chdir(tmpDir);
    const skills = discoverSkills();
    const skill = skills.find((s) => s.name === "underscore-when");
    expect(skill!.whenToUse).toBe("when testing underscores");
  });
});

// ---------------------------------------------------------------------------
// resolveSkillPrompt
// ---------------------------------------------------------------------------

describe("resolveSkillPrompt", () => {
  const baseSkill: SkillDefinition = {
    name: "test",
    description: "test skill",
    userInvocable: true,
    promptTemplate: "Run $ARGUMENTS in ${CLAUDE_SKILL_DIR}",
    source: "project",
    skillDir: "/path/to/skill",
  };

  test("substitutes $ARGUMENTS", () => {
    const result = resolveSkillPrompt(baseSkill, "hello world");
    expect(result).toContain("Run hello world");
  });

  test("substitutes ${ARGUMENTS}", () => {
    const skill = { ...baseSkill, promptTemplate: "Do ${ARGUMENTS} now" };
    const result = resolveSkillPrompt(skill, "this");
    expect(result).toBe("Do this now");
  });

  test("substitutes ${CLAUDE_SKILL_DIR}", () => {
    const result = resolveSkillPrompt(baseSkill, "args");
    expect(result).toContain("/path/to/skill");
  });

  test("replaces multiple occurrences", () => {
    const skill = {
      ...baseSkill,
      promptTemplate: "$ARGUMENTS and $ARGUMENTS again",
    };
    const result = resolveSkillPrompt(skill, "x");
    expect(result).toBe("x and x again");
  });

  test("handles empty args", () => {
    const result = resolveSkillPrompt(baseSkill, "");
    expect(result).toBe("Run  in /path/to/skill");
  });
});

// ---------------------------------------------------------------------------
// getSkillByName
// ---------------------------------------------------------------------------

describe("getSkillByName", () => {
  test("finds existing skill", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "lookup", `---
name: lookup
description: findable
---

body`);

    process.chdir(tmpDir);
    const skill = getSkillByName("lookup");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("lookup");
  });

  test("returns undefined for non-existent skill", () => {
    process.chdir(tmpDir);
    expect(getSkillByName("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeSkill
// ---------------------------------------------------------------------------

describe("executeSkill", () => {
  test("returns null for unknown skill", () => {
    process.chdir(tmpDir);
    expect(executeSkill("nope", "")).toBeNull();
  });

  test("returns inject context for skill without allowedTools", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "simple", `---
name: simple
description: simple skill
---

Do $ARGUMENTS`);

    process.chdir(tmpDir);
    const result = executeSkill("simple", "something");
    expect(result).not.toBeNull();
    expect(result!.context).toBe("inject");
    expect(result!.prompt).toBe("Do something");
    expect(result!.allowedTools).toBeUndefined();
  });

  test("returns fork context for skill with allowedTools", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "restricted", `---
name: restricted
description: restricted skill
allowed-tools: read_file
---

Only read $ARGUMENTS`);

    process.chdir(tmpDir);
    const result = executeSkill("restricted", "file.ts");
    expect(result).not.toBeNull();
    expect(result!.context).toBe("fork");
    expect(result!.allowedTools).toEqual(["read_file"]);
    expect(result!.prompt).toBe("Only read file.ts");
  });
});

// ---------------------------------------------------------------------------
// buildSkillDescriptions
// ---------------------------------------------------------------------------

describe("buildSkillDescriptions", () => {
  test("returns empty string when no skills", () => {
    process.chdir(tmpDir);
    expect(buildSkillDescriptions()).toBe("");
  });

  test("includes header and user-invocable section", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "commit", `---
name: commit
description: Create a git commit
when-to-use: when user asks to commit
---

body`);

    process.chdir(tmpDir);
    const desc = buildSkillDescriptions();
    expect(desc).toContain("# Available Skills");
    expect(desc).toContain("User-invocable skills");
    expect(desc).toContain("**/commit**");
    expect(desc).toContain("Create a git commit");
    expect(desc).toContain("when user asks to commit");
    expect(desc).toContain("skill` tool");
  });

  test("separates auto-invocable skills", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "auto-skill", `---
name: auto-skill
description: runs automatically
user-invocable: false
---

body`);

    process.chdir(tmpDir);
    const desc = buildSkillDescriptions();
    expect(desc).toContain("Auto-invocable skills");
    expect(desc).toContain("**auto-skill**");
    // Should NOT have slash prefix for auto-only skills
    expect(desc).not.toContain("/auto-skill");
  });

  test("includes both sections when mixed", () => {
    const skillsDir = join(tmpDir, ".claude", "skills");
    writeSkill(skillsDir, "user-skill", `---
name: user-skill
description: user can invoke
---

body`);
    writeSkill(skillsDir, "bg-skill", `---
name: bg-skill
description: background only
user-invocable: false
---

body`);

    process.chdir(tmpDir);
    const desc = buildSkillDescriptions();
    expect(desc).toContain("User-invocable skills");
    expect(desc).toContain("Auto-invocable skills");
    expect(desc).toContain("**/user-skill**");
    expect(desc).toContain("**bg-skill**");
  });
});
