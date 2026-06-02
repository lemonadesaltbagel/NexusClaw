// ---------------------------------------------------------------------------
// PdfProvider — describes one or more PDFs with a vision-capable model.
// Two dispatch shapes; the handler picks one:
//
//   * Native path     — provider takes the raw PDF binary as a document
//                       block. Used when the provider supports it AND the
//                       caller did NOT specify a page range.
//   * Extract path    — provider takes a pre-built [text, image, …, prompt]
//                       content array. Used when the provider has no
//                       native PDF support OR a page range was selected
//                       (extraction is what enforces the range).
//
// The PdfExtractor abstraction is what turns a Buffer into the
// [extracted text + page images] pair. Its implementation is intentionally
// stubbed here — real extraction (text + page-image rasterization) will
// land in a follow-up stage when media-storage management is wired up.
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";

/** A loaded PDF, kept as both Buffer and base64 because the two downstream
 *  paths consume different shapes. */
export interface PdfRef {
  /** Raw bytes — what the extractor reads. */
  buffer:    Buffer;
  /** Base64 string — what native providers send over the wire. */
  data:      string;
  /** MIME type for the native document block; always application/pdf in practice. */
  mediaType: string;
}

/** Output of the client-side PDF extractor. */
export interface ExtractedPdf {
  /** Plain text concatenation of the selected pages. */
  text: string;
  /** Rendered page images (base64), one entry per page in selection order. */
  pageImages: Array<{ data: string; mimeType: string }>;
}

export interface DescribeResult {
  text: string;
}

/** Extracts text + page images from a PDF buffer. Stub implementations are
 *  allowed — the handler simply forwards whatever they return. */
export interface PdfExtractor {
  extract(buffer: Buffer, pages?: string): Promise<ExtractedPdf>;
}

/**
 * Stub extractor — produces empty content with a placeholder text. Replaced
 * by a real `pdfjs-dist` / `pdf-parse` + rasterizer pipeline in a future
 * stage. Lets the rest of the analyze_pdf path be tested and wired today.
 */
export class StubPdfExtractor implements PdfExtractor {
  async extract(_buffer: Buffer, pages?: string): Promise<ExtractedPdf> {
    const pageNote = pages ? ` (pages: ${pages})` : "";
    return {
      text:       `[PDF text extraction not yet implemented${pageNote}]`,
      pageImages: [],
    };
  }
}

// ---------------------------------------------------------------------------
// PdfProvider interface
// ---------------------------------------------------------------------------

export interface PdfProvider {
  /** Identifier for logging and the `details.attempts` trail. */
  name:  string;
  model: string;

  /**
   * Send PDF(s) as native document blocks. Optional — only providers that
   * support it (Anthropic, Google) implement this. Absence triggers the
   * extract path.
   */
  describePdfNative?(prompt: string, pdfs: PdfRef[]): Promise<DescribeResult>;

  /**
   * Send pre-extracted [text, image, …, prompt] content. Required — every
   * provider must support this since it's the fallback for non-native
   * providers AND the path taken when a page range is selected.
   */
  describeExtracted(prompt: string, extracted: ExtractedPdf[]): Promise<DescribeResult>;
}

// ---------------------------------------------------------------------------
// Anthropic provider — both paths.
// ---------------------------------------------------------------------------

export class AnthropicPdfProvider implements PdfProvider {
  readonly name = "anthropic";

  constructor(
    private readonly client: Anthropic,
    public readonly model: string,
  ) {}

  async describePdfNative(prompt: string, pdfs: PdfRef[]): Promise<DescribeResult> {
    const blocks: Anthropic.Messages.ContentBlockParam[] = [];
    for (const pdf of pdfs) {
      blocks.push({
        type:   "document",
        source: { type: "base64", media_type: "application/pdf", data: pdf.data },
      } as Anthropic.Messages.ContentBlockParam);
    }
    // Prompt goes LAST so the model reads the document first.
    blocks.push({ type: "text", text: prompt });

    const res = await this.client.messages.create({
      model:      this.model,
      max_tokens: 4096,
      messages:   [{ role: "user", content: blocks }],
    });
    return { text: this.extractText(res) };
  }

  async describeExtracted(prompt: string, extracted: ExtractedPdf[]): Promise<DescribeResult> {
    const blocks: Anthropic.Messages.ContentBlockParam[] = [];
    for (let i = 0; i < extracted.length; i++) {
      const e      = extracted[i]!;
      const header = extracted.length > 1 ? `[PDF ${i + 1} text]` : "[PDF text]";
      blocks.push({ type: "text", text: `${header}\n${e.text}` });
      for (const img of e.pageImages) {
        blocks.push({
          type:   "image",
          source: { type: "base64", media_type: img.mimeType, data: img.data },
        } as Anthropic.Messages.ContentBlockParam);
      }
    }
    // Prompt goes LAST — the model reads everything above before answering.
    blocks.push({ type: "text", text: prompt });

    const res = await this.client.messages.create({
      model:      this.model,
      max_tokens: 4096,
      messages:   [{ role: "user", content: blocks }],
    });
    return { text: this.extractText(res) };
  }

  private extractText(res: Anthropic.Messages.Message): string {
    const parts: string[] = [];
    for (const b of res.content) {
      if (b.type === "text") parts.push(b.text);
    }
    return parts.join("\n").trim();
  }
}

// ---------------------------------------------------------------------------
// Process-wide registry (same pattern as ImageProvider).
// ---------------------------------------------------------------------------

type PdfProviderFactory = (model: string) => PdfProvider;

const registry = new Map<string, PdfProviderFactory>();

export function registerPdfProvider(providerName: string, factory: PdfProviderFactory): void {
  registry.set(providerName, factory);
}

export function resolvePdfProvider(
  providerName: string,
  model: string,
): PdfProvider | null {
  const factory = registry.get(providerName);
  if (!factory) return null;
  return factory(model);
}

/** Test helper — clear all registered factories. */
export function clearPdfProviders(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Extractor registry — paired with the provider registry. The handler can
// run the extract path even when the active provider has native support,
// because a page-range argument forces extraction.
// ---------------------------------------------------------------------------

let activeExtractor: PdfExtractor | null = new StubPdfExtractor();

export function setPdfExtractor(extractor: PdfExtractor | null): void {
  activeExtractor = extractor;
}

export function getPdfExtractor(): PdfExtractor | null {
  return activeExtractor;
}
