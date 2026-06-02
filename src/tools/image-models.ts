// ---------------------------------------------------------------------------
// Image-capable models — capability table for the analyze_image tool.
//
// Used in two places:
//   1. Gating: the tool's description switches based on whether the *main*
//      model already has native vision.
//   2. Resolution: pick a (provider, model) pair to do the actual describe
//      call. Falls back from "main model" to a configured `imageModel`.
//
// The list is deliberately small — only mainstream public models that this
// project's primary providers (Anthropic, OpenAI) ship. New providers can
// extend the table without changing the resolution logic.
// ---------------------------------------------------------------------------

export type Provider = "anthropic" | "openai";

export interface ModelCapability {
  /** Glob-ish prefix that matches the model name family. */
  prefix: string;
  provider: Provider;
  vision: boolean;
}

/**
 * Capability rows. Order matters: longer/more-specific prefixes win when
 * a model name matches multiple rows.
 */
export const MODEL_CAPABILITIES: ReadonlyArray<ModelCapability> = [
  // Anthropic — Claude 3 onwards is image-capable on every flagship.
  { prefix: "claude-opus-4",      provider: "anthropic", vision: true },
  { prefix: "claude-sonnet-4",    provider: "anthropic", vision: true },
  { prefix: "claude-haiku-4",     provider: "anthropic", vision: true },
  { prefix: "claude-3-5-sonnet",  provider: "anthropic", vision: true },
  { prefix: "claude-3-5-haiku",   provider: "anthropic", vision: true },
  { prefix: "claude-3-opus",      provider: "anthropic", vision: true },
  { prefix: "claude-3-sonnet",    provider: "anthropic", vision: true },
  { prefix: "claude-3-haiku",     provider: "anthropic", vision: true },
  { prefix: "claude-",            provider: "anthropic", vision: false }, // older

  // OpenAI — gpt-4 and gpt-4o families support image input.
  { prefix: "gpt-5",              provider: "openai",    vision: true },
  { prefix: "gpt-4.1",            provider: "openai",    vision: true },
  { prefix: "gpt-4o",             provider: "openai",    vision: true },
  { prefix: "gpt-4-turbo",        provider: "openai",    vision: true },
  { prefix: "gpt-4-vision",       provider: "openai",    vision: true },
  { prefix: "gpt-4",              provider: "openai",    vision: false }, // older flagship without vision
  { prefix: "gpt-3.5",            provider: "openai",    vision: false },
];

/** Find the most specific capability row matching this model name. */
export function lookupCapability(model: string): ModelCapability | undefined {
  let best: ModelCapability | undefined;
  for (const row of MODEL_CAPABILITIES) {
    if (model.startsWith(row.prefix)) {
      if (!best || row.prefix.length > best.prefix.length) best = row;
    }
  }
  return best;
}

/** True iff `model` has native image understanding in its main API. */
export function modelHasNativeVision(model: string): boolean {
  return lookupCapability(model)?.vision ?? false;
}

/**
 * Parse a config-style model identifier into (provider, model). Accepts:
 *   "openai/gpt-4o-mini"   → { provider: "openai",    model: "gpt-4o-mini" }
 *   "claude-opus-4-6"      → { provider: "anthropic", model: "claude-opus-4-6" } (inferred)
 * Returns undefined if the provider can't be inferred.
 */
export function parseModelId(id: string): { provider: Provider; model: string } | undefined {
  const slash = id.indexOf("/");
  if (slash > 0) {
    const provider = id.slice(0, slash);
    const model    = id.slice(slash + 1);
    if (provider === "anthropic" || provider === "openai") {
      return { provider, model };
    }
    return undefined;
  }
  const cap = lookupCapability(id);
  if (cap) return { provider: cap.provider, model: id };
  return undefined;
}
