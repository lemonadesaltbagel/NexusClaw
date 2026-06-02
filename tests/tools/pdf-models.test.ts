import { test, expect, describe } from "bun:test";
import {
  modelHasNativePdf,
  lookupPdfCapability,
  parsePdfModelId,
} from "@/tools/pdf-models";

describe("modelHasNativePdf", () => {
  test("Claude 3+ family supports native PDF", () => {
    expect(modelHasNativePdf("claude-opus-4-6")).toBe(true);
    expect(modelHasNativePdf("claude-sonnet-4-5")).toBe(true);
    expect(modelHasNativePdf("claude-3-5-sonnet-20240620")).toBe(true);
    expect(modelHasNativePdf("claude-3-opus-20240229")).toBe(true);
  });
  test("Gemini 1.5+ supports native PDF", () => {
    expect(modelHasNativePdf("gemini-2.0-pro")).toBe(true);
    expect(modelHasNativePdf("gemini-1.5-flash")).toBe(true);
  });
  test("OpenAI GPT family does NOT support native PDF", () => {
    expect(modelHasNativePdf("gpt-4o")).toBe(false);
    expect(modelHasNativePdf("gpt-4o-mini")).toBe(false);
    expect(modelHasNativePdf("gpt-4-turbo")).toBe(false);
    expect(modelHasNativePdf("gpt-3.5-turbo")).toBe(false);
  });
  test("older Claude (pre-3) does NOT support native PDF", () => {
    expect(modelHasNativePdf("claude-2.1")).toBe(false);
    expect(modelHasNativePdf("claude-instant-1")).toBe(false);
  });
  test("unknown model defaults to false", () => {
    expect(modelHasNativePdf("mystery-model")).toBe(false);
  });
});

describe("lookupPdfCapability — longest prefix wins", () => {
  test("'claude-3-5-sonnet' beats 'claude-' for a 3.5 model", () => {
    const c = lookupPdfCapability("claude-3-5-sonnet-20240620");
    expect(c?.prefix).toBe("claude-3-5-sonnet");
  });
  test("'gemini-1.5' beats 'gemini-'", () => {
    const c = lookupPdfCapability("gemini-1.5-pro");
    expect(c?.prefix).toBe("gemini-1.5");
  });
});

describe("parsePdfModelId", () => {
  test("explicit provider/model parses both halves", () => {
    expect(parsePdfModelId("anthropic/claude-opus-4-6"))
      .toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
    expect(parsePdfModelId("google/gemini-2.0-pro"))
      .toEqual({ provider: "google", model: "gemini-2.0-pro" });
    expect(parsePdfModelId("openai/gpt-4o-mini"))
      .toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });
  test("bare model name infers provider from capability table", () => {
    expect(parsePdfModelId("claude-opus-4-6"))
      .toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
    expect(parsePdfModelId("gemini-1.5-flash"))
      .toEqual({ provider: "google", model: "gemini-1.5-flash" });
  });
  test("unknown bare model returns undefined", () => {
    expect(parsePdfModelId("mystery-model")).toBeUndefined();
  });
  test("unknown provider prefix returns undefined", () => {
    expect(parsePdfModelId("cohere/command-r")).toBeUndefined();
  });
});
