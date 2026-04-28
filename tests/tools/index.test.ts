import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { buildTool, type Tool, type ToolSpec } from "@/tools/index";
import type { ToolContext, ToolProgressData } from "@/core/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyContext: ToolContext = {
  cwd: "/tmp",
  messages: [],
};

/** Minimal spec that satisfies all required fields. */
function minimalSpec(): ToolSpec<z.ZodObject<{ x: z.ZodString }>> {
  return {
    name: "test_tool",
    maxResultSizeChars: 1000,
    inputSchema: z.object({ x: z.string() }),
    async call() {
      return { output: "ok" };
    },
    async description() {
      return "A test tool";
    },
    async prompt() {
      return "Use test_tool";
    },
    renderToolUseMessage() {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. buildTool — fail-closed defaults
// ---------------------------------------------------------------------------

describe("buildTool", () => {
  test("fills in fail-closed defaults when omitted", () => {
    const tool = buildTool(minimalSpec());

    // isConcurrencySafe defaults to false (restrictive)
    expect(tool.isConcurrencySafe({ x: "anything" })).toBe(false);

    // isReadOnly defaults to false (assumed to have side effects)
    expect(tool.isReadOnly({ x: "anything" })).toBe(false);

    // isDestructive defaults to false
    expect(tool.isDestructive?.({ x: "anything" })).toBe(false);
  });

  test("checkPermissions defaults to allow", async () => {
    const tool = buildTool(minimalSpec());
    const result = await tool.checkPermissions({ x: "test" }, dummyContext);
    expect(result).toEqual({ behavior: "allow" });
  });

  test("preserves user-provided overrides", () => {
    const tool = buildTool({
      ...minimalSpec(),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isDestructive: () => true,
      checkPermissions: async () => ({ behavior: "deny", reason: "nope" }),
    });

    expect(tool.isConcurrencySafe({ x: "" })).toBe(true);
    expect(tool.isReadOnly({ x: "" })).toBe(true);
    expect(tool.isDestructive?.({ x: "" })).toBe(true);
  });

  test("user-provided checkPermissions overrides default", async () => {
    const tool = buildTool({
      ...minimalSpec(),
      checkPermissions: async () => ({ behavior: "deny", reason: "blocked" }),
    });

    const result = await tool.checkPermissions({ x: "" }, dummyContext);
    expect(result).toEqual({ behavior: "deny", reason: "blocked" });
  });

  test("call() is forwarded correctly", async () => {
    const tool = buildTool({
      ...minimalSpec(),
      async call(args) {
        return { output: `received: ${args.x}` };
      },
    });

    const result = await tool.call(
      { x: "hello" },
      dummyContext,
      () => false,
      {},
    );
    expect(result).toEqual({ output: "received: hello" });
  });

  test("name and aliases are preserved", () => {
    const tool = buildTool({
      ...minimalSpec(),
      name: "my_tool",
      aliases: ["old_tool"],
    });

    expect(tool.name).toBe("my_tool");
    expect(tool.aliases).toEqual(["old_tool"]);
  });

  test("optional renderToolResultMessage is preserved when provided", () => {
    const renderer = () => "rendered";
    const tool = buildTool({
      ...minimalSpec(),
      renderToolResultMessage: renderer,
    });

    expect(tool.renderToolResultMessage).toBe(renderer);
  });

  test("optional renderToolResultMessage is undefined when omitted", () => {
    const tool = buildTool(minimalSpec());
    expect(tool.renderToolResultMessage).toBeUndefined();
  });
});
