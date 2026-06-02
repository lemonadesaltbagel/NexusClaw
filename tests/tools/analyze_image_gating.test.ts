import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { gateAnalyzeImage } from "@/tools/definitions";
import {
  registerImageProvider,
  clearImageProviders,
  type ImageProvider,
} from "@/tools/image-provider";

const stubProvider = (name: string, model: string): ImageProvider => ({
  name, model,
  async describeImage() { return { text: "ok" }; },
});

beforeEach(() => clearImageProviders());
afterEach(()  => clearImageProviders());

describe("gateAnalyzeImage", () => {
  test("returns null silently when no provider is registered and no config demand", () => {
    expect(gateAnalyzeImage({ mainModel: "gpt-3.5-turbo" })).toBeNull();
  });

  test("returns the tool when main model has native vision and a provider is registered", () => {
    registerImageProvider("anthropic", (model) => stubProvider("anthropic", model));
    const g = gateAnalyzeImage({ mainModel: "claude-opus-4-6" });
    expect(g).not.toBeNull();
    expect(g!.tool.name).toBe("analyze_image");
    expect(g!.provider).toBe("anthropic");
    expect(g!.model).toBe("claude-opus-4-6");
  });

  test("description switches by main model vision capability", () => {
    registerImageProvider("anthropic", (model) => stubProvider("anthropic", model));
    registerImageProvider("openai",    (model) => stubProvider("openai", model));

    const visionMain = gateAnalyzeImage({ mainModel: "claude-opus-4-6" })!;
    expect(visionMain.tool.description).toContain("automatically visible to you");

    // No native-vision main model; explicit imageModel demand satisfies the gate.
    const noVisionMain = gateAnalyzeImage({
      mainModel:            "gpt-3.5-turbo",
      configuredImageModel: "openai/gpt-4o-mini",
      agentDir:             "/tmp/agent",
    });
    expect(noVisionMain!.tool.description).toContain("agents.defaults.imageModel");
  });

  test("explicit configuredImageModel without agentDir THROWS", () => {
    registerImageProvider("openai", (model) => stubProvider("openai", model));
    expect(() => gateAnalyzeImage({
      mainModel:            "gpt-3.5-turbo",
      configuredImageModel: "openai/gpt-4o-mini",
    })).toThrow(/agentDir/);
  });

  test("explicit configuredImageModel with agentDir but unknown provider returns null", () => {
    // no registerImageProvider call → resolveImageProvider returns null
    const g = gateAnalyzeImage({
      mainModel:            "gpt-3.5-turbo",
      configuredImageModel: "openai/gpt-4o-mini",
      agentDir:             "/tmp/agent",
    });
    expect(g).toBeNull();
  });

  test("explicit imageModel with bad format silently returns null", () => {
    expect(gateAnalyzeImage({
      mainModel:            "claude-opus-4-6",
      configuredImageModel: "garbage::nonsense",
      agentDir:             "/tmp/agent",
    })).toBeNull();
  });

  test("explicit imageModel beats main-model native vision", () => {
    registerImageProvider("anthropic", (model) => stubProvider("anthropic", model));
    registerImageProvider("openai",    (model) => stubProvider("openai", model));
    const g = gateAnalyzeImage({
      mainModel:            "claude-opus-4-6",         // would self-resolve to anthropic
      configuredImageModel: "openai/gpt-4o-mini",
      agentDir:             "/tmp/agent",
    });
    expect(g!.provider).toBe("openai");
    expect(g!.model).toBe("gpt-4o-mini");
  });

  test("schema accepts both `image` and `images`", () => {
    registerImageProvider("anthropic", (model) => stubProvider("anthropic", model));
    const g = gateAnalyzeImage({ mainModel: "claude-opus-4-6" })!;
    expect(g.tool.input_schema.properties.image).toBeDefined();
    expect(g.tool.input_schema.properties.images).toBeDefined();
    expect(g.tool.input_schema.properties.prompt).toBeDefined();
    // No required[] — both fields are individually optional.
    expect(g.tool.input_schema.required).toBeUndefined();
  });
});
