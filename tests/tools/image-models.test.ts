import { test, expect, describe } from "bun:test";
import {
  modelHasNativeVision,
  lookupCapability,
  parseModelId,
} from "@/tools/image-models";

describe("modelHasNativeVision", () => {
  test("Claude 3+ family is vision-capable", () => {
    expect(modelHasNativeVision("claude-opus-4-6")).toBe(true);
    expect(modelHasNativeVision("claude-sonnet-4-5")).toBe(true);
    expect(modelHasNativeVision("claude-3-5-sonnet-20240620")).toBe(true);
    expect(modelHasNativeVision("claude-3-opus-20240229")).toBe(true);
  });
  test("older Claude (pre-3) is not vision-capable", () => {
    expect(modelHasNativeVision("claude-2.1")).toBe(false);
    expect(modelHasNativeVision("claude-instant-1")).toBe(false);
  });
  test("GPT-4o + GPT-4-turbo + GPT-4-vision + 4.1 + 5 are vision-capable", () => {
    expect(modelHasNativeVision("gpt-4o-mini")).toBe(true);
    expect(modelHasNativeVision("gpt-4o")).toBe(true);
    expect(modelHasNativeVision("gpt-4-turbo")).toBe(true);
    expect(modelHasNativeVision("gpt-4-vision-preview")).toBe(true);
    expect(modelHasNativeVision("gpt-4.1-mini")).toBe(true);
    expect(modelHasNativeVision("gpt-5-pro")).toBe(true);
  });
  test("GPT-3.5 and base GPT-4 are NOT vision-capable", () => {
    expect(modelHasNativeVision("gpt-3.5-turbo")).toBe(false);
    expect(modelHasNativeVision("gpt-4")).toBe(false);
  });
  test("unknown model defaults to false (no false positives)", () => {
    expect(modelHasNativeVision("unknown-model-xyz")).toBe(false);
  });
});

describe("lookupCapability — longest prefix wins", () => {
  test("'claude-3-5-sonnet' beats 'claude-' for a 3.5 model", () => {
    const c = lookupCapability("claude-3-5-sonnet-20240620");
    expect(c?.prefix).toBe("claude-3-5-sonnet");
  });
  test("'claude-' catches an older model that no longer-prefix matches", () => {
    const c = lookupCapability("claude-2.1");
    expect(c?.prefix).toBe("claude-");
  });
});

describe("parseModelId", () => {
  test("explicit provider/model parses both halves", () => {
    expect(parseModelId("openai/gpt-4o-mini")).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(parseModelId("anthropic/claude-opus-4-6")).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });
  test("bare model name infers provider from capability table", () => {
    expect(parseModelId("claude-opus-4-6")).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
    expect(parseModelId("gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
  });
  test("unknown bare model returns undefined", () => {
    expect(parseModelId("mystery-model")).toBeUndefined();
  });
  test("unknown provider prefix returns undefined", () => {
    expect(parseModelId("groq/llama-3")).toBeUndefined();
  });
});
