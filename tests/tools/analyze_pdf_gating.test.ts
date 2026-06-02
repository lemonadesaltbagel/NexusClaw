import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { gateAnalyzePdf } from "@/tools/definitions";
import {
  registerPdfProvider,
  clearPdfProviders,
  type PdfProvider,
} from "@/tools/pdf-provider";

const stubProvider = (name: string, model: string): PdfProvider => ({
  name, model,
  async describeExtracted() { return { text: "ok" }; },
});

beforeEach(() => clearPdfProviders());
afterEach(()  => clearPdfProviders());

describe("gateAnalyzePdf", () => {
  test("returns null silently when no provider is registered and no config demand", () => {
    expect(gateAnalyzePdf({ mainModel: "gpt-3.5-turbo" })).toBeNull();
  });

  test("returns the tool when main model has native PDF and a provider is registered", () => {
    registerPdfProvider("anthropic", (model) => stubProvider("anthropic", model));
    const g = gateAnalyzePdf({ mainModel: "claude-opus-4-6" });
    expect(g).not.toBeNull();
    expect(g!.tool.name).toBe("analyze_pdf");
    expect(g!.provider).toBe("anthropic");
    expect(g!.model).toBe("claude-opus-4-6");
  });

  test("OpenAI main model does NOT auto-enable the tool (no native PDF)", () => {
    registerPdfProvider("openai", (model) => stubProvider("openai", model));
    expect(gateAnalyzePdf({ mainModel: "gpt-4o" })).toBeNull();
  });

  test("explicit configuredPdfModel without agentDir THROWS", () => {
    registerPdfProvider("anthropic", (model) => stubProvider("anthropic", model));
    expect(() => gateAnalyzePdf({
      mainModel:           "gpt-3.5-turbo",
      configuredPdfModel:  "anthropic/claude-opus-4-6",
    })).toThrow(/agentDir/);
  });

  test("explicit configuredPdfModel with agentDir but unknown provider returns null", () => {
    // no registerPdfProvider call → resolvePdfProvider returns null
    const g = gateAnalyzePdf({
      mainModel:           "gpt-3.5-turbo",
      configuredPdfModel:  "anthropic/claude-opus-4-6",
      agentDir:            "/tmp/agent",
    });
    expect(g).toBeNull();
  });

  test("explicit pdfModel with bad format silently returns null", () => {
    expect(gateAnalyzePdf({
      mainModel:           "claude-opus-4-6",
      configuredPdfModel:  "garbage::nonsense",
      agentDir:            "/tmp/agent",
    })).toBeNull();
  });

  test("explicit pdfModel beats main-model native PDF", () => {
    registerPdfProvider("anthropic", (model) => stubProvider("anthropic", model));
    registerPdfProvider("google",    (model) => stubProvider("google", model));
    const g = gateAnalyzePdf({
      mainModel:           "claude-opus-4-6",       // would self-resolve to anthropic
      configuredPdfModel:  "google/gemini-1.5-pro",
      agentDir:            "/tmp/agent",
    });
    expect(g!.provider).toBe("google");
    expect(g!.model).toBe("gemini-1.5-pro");
  });

  test("schema accepts pdf / pdfs / prompt / pages", () => {
    registerPdfProvider("anthropic", (model) => stubProvider("anthropic", model));
    const g = gateAnalyzePdf({ mainModel: "claude-opus-4-6" })!;
    expect(g.tool.input_schema.properties.pdf).toBeDefined();
    expect(g.tool.input_schema.properties.pdfs).toBeDefined();
    expect(g.tool.input_schema.properties.prompt).toBeDefined();
    expect(g.tool.input_schema.properties.pages).toBeDefined();
    expect(g.tool.input_schema.required).toBeUndefined();
  });

  test("description mentions native + extraction fallback", () => {
    registerPdfProvider("anthropic", (model) => stubProvider("anthropic", model));
    const g = gateAnalyzePdf({ mainModel: "claude-opus-4-6" })!;
    expect(g.tool.description).toContain("native PDF");
    expect(g.tool.description).toContain("extraction");
  });
});
