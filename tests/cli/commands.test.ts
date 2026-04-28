import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// resolveApiKey tests
//
// Since resolveApiKey is a local function in commands.ts, we test the
// logic by extracting it here. This mirrors the implementation exactly.
// ---------------------------------------------------------------------------

function resolveApiKey(apiBase?: string): string | undefined {
  if (apiBase) {
    return process.env.OPENAI_API_KEY;
  }
  return process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
}

describe("resolveApiKey", () => {
  let origAnthropic: string | undefined;
  let origOpenAI: string | undefined;

  beforeEach(() => {
    origAnthropic = process.env.ANTHROPIC_API_KEY;
    origOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (origOpenAI !== undefined) process.env.OPENAI_API_KEY = origOpenAI;
    else delete process.env.OPENAI_API_KEY;
  });

  test("returns undefined when no keys are set", () => {
    expect(resolveApiKey()).toBeUndefined();
  });

  test("returns ANTHROPIC_API_KEY when set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-123";
    expect(resolveApiKey()).toBe("sk-ant-123");
  });

  test("returns OPENAI_API_KEY as fallback when ANTHROPIC_API_KEY not set", () => {
    process.env.OPENAI_API_KEY = "sk-oai-456";
    expect(resolveApiKey()).toBe("sk-oai-456");
  });

  test("ANTHROPIC_API_KEY takes priority over OPENAI_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-123";
    process.env.OPENAI_API_KEY = "sk-oai-456";
    expect(resolveApiKey()).toBe("sk-ant-123");
  });

  test("with apiBase set, uses OPENAI_API_KEY only", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-123";
    process.env.OPENAI_API_KEY = "sk-oai-456";
    expect(resolveApiKey("https://custom.api.com")).toBe("sk-oai-456");
  });

  test("with apiBase set and no OPENAI_API_KEY, returns undefined", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-123";
    expect(resolveApiKey("https://custom.api.com")).toBeUndefined();
  });
});
