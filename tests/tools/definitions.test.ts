import { test, expect, describe } from "bun:test";
import { toolDefinitions, type ToolDef } from "@/tools/definitions";

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
