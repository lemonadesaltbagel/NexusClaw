import { test, expect, describe, beforeEach } from "bun:test";
import {
  toolDefinitions,
  activatedTools,
  getActiveToolDefinitions,
  getDeferredToolNames,
  type ToolDef,
} from "@/tools/definitions";

// ---------------------------------------------------------------------------
// Tool definitions — structure validation
// ---------------------------------------------------------------------------

describe("toolDefinitions", () => {
  test("exports a non-empty array", () => {
    expect(Array.isArray(toolDefinitions)).toBe(true);
    expect(toolDefinitions.length).toBeGreaterThan(0);
  });

  test("every definition has required fields", () => {
    for (const def of toolDefinitions) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);

      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);

      expect(def.input_schema.type).toBe("object");
      expect(typeof def.input_schema.properties).toBe("object");
    }
  });

  test("tool names are unique", () => {
    const names = toolDefinitions.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("contains expected tool names", () => {
    const names = toolDefinitions.map((d) => d.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("list_files");
    expect(names).toContain("grep_search");
    expect(names).toContain("run_shell");
    expect(names).toContain("tool_search");
  });

  test("required fields reference existing properties", () => {
    for (const def of toolDefinitions) {
      if (def.input_schema.required) {
        for (const req of def.input_schema.required) {
          expect(def.input_schema.properties).toHaveProperty(req);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Deferred tool activation
// ---------------------------------------------------------------------------

describe("getActiveToolDefinitions", () => {
  beforeEach(() => {
    activatedTools.clear();
  });

  const sampleTools: ToolDef[] = [
    {
      name: "always_on",
      description: "Always available",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "lazy_tool",
      description: "Only when needed",
      input_schema: { type: "object", properties: {} },
      deferred: true,
    },
  ];

  test("excludes deferred tools by default", () => {
    const active = getActiveToolDefinitions(sampleTools);
    const names = active.map((t) => t.name);
    expect(names).toContain("always_on");
    expect(names).not.toContain("lazy_tool");
  });

  test("includes deferred tools once activated", () => {
    activatedTools.add("lazy_tool");
    const active = getActiveToolDefinitions(sampleTools);
    const names = active.map((t) => t.name);
    expect(names).toContain("lazy_tool");
  });

  test("strips the deferred field from output", () => {
    activatedTools.add("lazy_tool");
    const active = getActiveToolDefinitions(sampleTools);
    for (const t of active) {
      expect(t).not.toHaveProperty("deferred");
    }
  });
});

describe("getDeferredToolNames", () => {
  beforeEach(() => {
    activatedTools.clear();
  });

  const sampleTools: ToolDef[] = [
    {
      name: "normal",
      description: "Normal tool",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "deferred_a",
      description: "Deferred A",
      input_schema: { type: "object", properties: {} },
      deferred: true,
    },
    {
      name: "deferred_b",
      description: "Deferred B",
      input_schema: { type: "object", properties: {} },
      deferred: true,
    },
  ];

  test("returns names of all unactivated deferred tools", () => {
    const names = getDeferredToolNames(sampleTools);
    expect(names).toEqual(["deferred_a", "deferred_b"]);
  });

  test("excludes activated deferred tools", () => {
    activatedTools.add("deferred_a");
    const names = getDeferredToolNames(sampleTools);
    expect(names).toEqual(["deferred_b"]);
  });

  test("returns empty array when all deferred tools are activated", () => {
    activatedTools.add("deferred_a");
    activatedTools.add("deferred_b");
    const names = getDeferredToolNames(sampleTools);
    expect(names).toEqual([]);
  });
});
