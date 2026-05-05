import { test, expect, describe } from "bun:test";
import {
  getSubAgentConfig,
  getReadOnlyTools,
  buildAgentDescriptions,
  type SubAgentType,
} from "@/core/subagent";
import { toolDefinitions } from "@/tools/definitions";

// ---------------------------------------------------------------------------
// getReadOnlyTools
// ---------------------------------------------------------------------------

describe("getReadOnlyTools", () => {
  test("returns only read-only tools", () => {
    const tools = getReadOnlyTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("list_files");
    expect(names).toContain("grep_search");
    expect(names).toContain("run_shell");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("agent");
  });

  test("returns exactly 4 tools", () => {
    const tools = getReadOnlyTools();
    expect(tools.length).toBe(4);
  });

  test("returns valid ToolDef objects", () => {
    const tools = getReadOnlyTools();
    for (const tool of tools) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("input_schema");
    }
  });
});

// ---------------------------------------------------------------------------
// getSubAgentConfig
// ---------------------------------------------------------------------------

describe("getSubAgentConfig", () => {
  test("explore type returns read-only tools and explore prompt", () => {
    const config = getSubAgentConfig("explore");
    expect(config.systemPrompt).toContain("Explore agent");
    expect(config.systemPrompt).toContain("READ-ONLY");
    const names = config.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("agent");
  });

  test("plan type returns read-only tools and plan prompt", () => {
    const config = getSubAgentConfig("plan");
    expect(config.systemPrompt).toContain("Plan agent");
    expect(config.systemPrompt).toContain("READ-ONLY");
    const names = config.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("agent");
  });

  test("general type returns all tools except agent", () => {
    const config = getSubAgentConfig("general");
    expect(config.systemPrompt).toContain("General sub-agent");
    const names = config.tools.map((t) => t.name);
    expect(names).not.toContain("agent");
    // Should have more tools than read-only
    expect(config.tools.length).toBeGreaterThan(4);
  });

  test("general type includes write and edit tools", () => {
    const config = getSubAgentConfig("general");
    const names = config.tools.map((t) => t.name);
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
  });

  test("explore and plan types return identical tool sets", () => {
    const explore = getSubAgentConfig("explore");
    const plan = getSubAgentConfig("plan");
    const exploreNames = explore.tools.map((t) => t.name).sort();
    const planNames = plan.tools.map((t) => t.name).sort();
    expect(exploreNames).toEqual(planNames);
  });

  test("explore and plan types have different prompts", () => {
    const explore = getSubAgentConfig("explore");
    const plan = getSubAgentConfig("plan");
    expect(explore.systemPrompt).not.toBe(plan.systemPrompt);
  });
});

// ---------------------------------------------------------------------------
// buildAgentDescriptions
// ---------------------------------------------------------------------------

describe("buildAgentDescriptions", () => {
  test("includes all three agent types", () => {
    const desc = buildAgentDescriptions();
    expect(desc).toContain("explore");
    expect(desc).toContain("plan");
    expect(desc).toContain("general");
  });

  test("includes header", () => {
    const desc = buildAgentDescriptions();
    expect(desc).toContain("# Available sub-agents");
  });

  test("formats as markdown list items", () => {
    const desc = buildAgentDescriptions();
    expect(desc).toContain("- **explore**:");
    expect(desc).toContain("- **plan**:");
    expect(desc).toContain("- **general**:");
  });

  test("returns non-empty string", () => {
    const desc = buildAgentDescriptions();
    expect(desc.length).toBeGreaterThan(0);
  });
});
