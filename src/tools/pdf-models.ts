// ---------------------------------------------------------------------------
// PDF-capable models — capability table for the analyze_pdf tool.
//
// "Native PDF" means the provider's chat API accepts a PDF binary as a
// document block in the message content (Anthropic's `type: "document"`,
// Google's `inlineData` with `application/pdf`). When that's available
// we forward the binary directly; otherwise the handler falls back to
// the extract path (client-side text + page-image extraction, then a
// regular text-and-images describe call).
//
// Shape mirrors `image-models.ts` so the gating logic stays consistent.
// ---------------------------------------------------------------------------

export type PdfProviderName = "anthropic" | "openai" | "google";

export interface PdfModelCapability {
  /** Glob-ish prefix that matches the model name family. */
  prefix: string;
  provider: PdfProviderName;
  /** True iff the model accepts PDF as a native document block. */
  nativePdf: boolean;
}

/**
 * Capability rows. Order matters: longer/more-specific prefixes win when
 * a model name matches multiple rows.
 */
export const PDF_MODEL_CAPABILITIES: ReadonlyArray<PdfModelCapability> = [
  // Anthropic — Claude 3+ supports PDF as a document block.
  { prefix: "claude-opus-4",      provider: "anthropic", nativePdf: true },
  { prefix: "claude-sonnet-4",    provider: "anthropic", nativePdf: true },
  { prefix: "claude-haiku-4",     provider: "anthropic", nativePdf: true },
  { prefix: "claude-3-5-sonnet",  provider: "anthropic", nativePdf: true },
  { prefix: "claude-3-5-haiku",   provider: "anthropic", nativePdf: true },
  { prefix: "claude-3-opus",      provider: "anthropic", nativePdf: true },
  { prefix: "claude-3-sonnet",    provider: "anthropic", nativePdf: true },
  { prefix: "claude-3-haiku",     provider: "anthropic", nativePdf: true },
  { prefix: "claude-",            provider: "anthropic", nativePdf: false }, // older

  // Google Gemini — 1.5 onward accepts native PDF.
  { prefix: "gemini-2",           provider: "google",    nativePdf: true },
  { prefix: "gemini-1.5",         provider: "google",    nativePdf: true },
  { prefix: "gemini-",            provider: "google",    nativePdf: false },

  // OpenAI — no native PDF in the chat completions API (must use extract).
  { prefix: "gpt-5",              provider: "openai",    nativePdf: false },
  { prefix: "gpt-4.1",            provider: "openai",    nativePdf: false },
  { prefix: "gpt-4o",             provider: "openai",    nativePdf: false },
  { prefix: "gpt-4-turbo",        provider: "openai",    nativePdf: false },
  { prefix: "gpt-4",              provider: "openai",    nativePdf: false },
  { prefix: "gpt-3.5",            provider: "openai",    nativePdf: false },
];

/** Find the most specific capability row matching this model name. */
export function lookupPdfCapability(model: string): PdfModelCapability | undefined {
  let best: PdfModelCapability | undefined;
  for (const row of PDF_MODEL_CAPABILITIES) {
    if (model.startsWith(row.prefix)) {
      if (!best || row.prefix.length > best.prefix.length) best = row;
    }
  }
  return best;
}

/** True iff `model` accepts PDFs as a native document block. */
export function modelHasNativePdf(model: string): boolean {
  return lookupPdfCapability(model)?.nativePdf ?? false;
}

/**
 * Parse a config-style PDF model identifier into (provider, model). Accepts:
 *   "anthropic/claude-opus-4-6" → { provider: "anthropic", model: "claude-opus-4-6" }
 *   "claude-opus-4-6"            → inferred
 * Returns undefined if the provider can't be inferred.
 */
export function parsePdfModelId(
  id: string,
): { provider: PdfProviderName; model: string } | undefined {
  const slash = id.indexOf("/");
  if (slash > 0) {
    const provider = id.slice(0, slash);
    const model    = id.slice(slash + 1);
    if (provider === "anthropic" || provider === "openai" || provider === "google") {
      return { provider, model };
    }
    return undefined;
  }
  const cap = lookupPdfCapability(id);
  if (cap) return { provider: cap.provider, model: id };
  return undefined;
}
