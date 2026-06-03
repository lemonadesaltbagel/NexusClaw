// ---------------------------------------------------------------------------
// analyze_pdf — describe one or more PDF documents with a model.
//
// Inputs:
//   * pdf:    string                  — single path / URL / data URL
//   * pdfs:   string[]                — multiple sources (≤ 10)
//   * prompt: string                  — instruction passed to the model
//   * pages:  string                  — "1-5", "1,3,5-7", etc. When set,
//                                       forces the extract path so the
//                                       extractor can honor the range.
//
// Strategy:
//   * Native PDF available + no page range → describePdfNative
//   * Otherwise                            → extract → describeExtracted
//
// Content ordering for the extract path is fixed: [text, image, …, prompt].
// The prompt always goes LAST so the model reads the document first.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs";
import { promisify } from "node:util";
import { resolve as resolvePath, isAbsolute } from "node:path";
import {
  classifyImage,
  resolveUserPath,
  assembleCandidates,
} from "@/tools/handlers/analyze_image";
import {
  getDefaultMediaStorage,
  type MediaStorage,
} from "@/remote/media-storage";
import type {
  PdfProvider,
  PdfRef,
  ExtractedPdf,
  DescribeResult,
  PdfExtractor,
} from "@/tools/pdf-provider";

const readFileAsync = promisify(readFile);

/** PDFs are bigger and rarer than images — a stricter cap. */
export const MAX_PDFS = 10;

// ---------------------------------------------------------------------------
// Input / output / error shapes
// ---------------------------------------------------------------------------

export interface AnalyzePdfInput {
  pdf?:    string;
  pdfs?:   string[];
  prompt?: string;
  pages?:  string;
}

export interface AnalyzePdfOutput {
  content: Array<{ type: "text"; text: string }>;
  details: {
    model:         string;             // "provider/model"
    native:        boolean;            // which path was taken
    pdf?:          string;             // single
    pdfs?:         string[];           // many
    rewrittenFrom?: Record<string, string>;
    attempts:      Array<{ provider: string; model: string; error?: string }>;
  };
}

export type AnalyzePdfError =
  | { error: "too_many_pdfs";  count: number }
  | { error: "no_pdfs" }
  | { error: "no_provider" }
  | { error: "no_extractor" }
  | { error: "read_failed";    path: string; cause: string }
  | { error: "model_failed";   attempts: Array<{ provider: string; model: string; error: string }> };

// ---------------------------------------------------------------------------
// Resolve one PDF: read into Buffer + base64, keep BOTH (native path
// wants base64 over the wire; extract path wants the Buffer to parse).
// Reuses the image handler's path classification — the kinds are
// resource-agnostic (paths, URLs, schemes don't care if the bytes are
// an image or a PDF).
// ---------------------------------------------------------------------------

export interface ResolvedPdf {
  ref:           PdfRef;
  original:      string;
  resolved:      string;
  rewrittenFrom?: string;
}

export interface ResolvePdfContext {
  workspaceDir:    string;
  sandboxRewrite?: (path: string) => string | undefined;
  mediaStorage?:   MediaStorage;
}

export async function resolvePdfOne(
  raw: string,
  ctx: ResolvePdfContext,
): Promise<ResolvedPdf> {
  const kind = classifyImage(raw);

  if (kind === "data-url") {
    const m = raw.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
    const mediaType = m?.[1] ?? "application/pdf";
    const data      = m?.[2] ?? "";
    return {
      ref:      { buffer: Buffer.from(data, "base64"), data, mediaType },
      original: raw,
      resolved: raw,
    };
  }

  if (kind === "http-url" || kind === "pseudo-uri") {
    // The native PDF document block doesn't take URL refs as widely as
    // images; keep the simple invariant of "always Buffer + base64" by
    // fetching. For now, surface the URL as an unsupported source so the
    // handler returns a clear read_failed error. (Real fetching can be
    // wired in a later stage along with media-storage management.)
    throw new Error(`URL PDFs are not yet supported (got "${raw}")`);
  }

  let path = raw;
  if (kind === "file-url")           path = raw.replace(/^file:\/{2,3}/i, "/");
  else if (kind === "media-uri") {
    const storage = ctx.mediaStorage ?? getDefaultMediaStorage();
    const resolved = storage.resolveUri(raw);
    if (!resolved) throw new Error(`media URI not found on disk: ${raw}`);
    path = resolved;
  }
  else if (kind === "home-path")     path = resolveUserPath(raw);
  else if (kind === "relative-path") path = resolvePath(ctx.workspaceDir, raw);
  // windows-path / absolute-path: use as-is
  else if (kind !== "windows-path" && kind !== "absolute-path") {
    // Defensive — should never hit, but if `classifyImage` grows a new
    // kind we'd surface it instead of silently reading the wrong thing.
    if (!isAbsolute(path)) path = resolvePath(ctx.workspaceDir, path);
  }

  let rewrittenFrom: string | undefined;
  if (ctx.sandboxRewrite) {
    const rewritten = ctx.sandboxRewrite(path);
    if (rewritten && rewritten !== path) {
      rewrittenFrom = path;
      path = rewritten;
    }
  }

  const buffer = await readFileAsync(path);
  return {
    ref: {
      buffer,
      data:      buffer.toString("base64"),
      mediaType: "application/pdf",
    },
    original: raw,
    resolved: path,
    rewrittenFrom,
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

export interface AnalyzePdfContext {
  provider:     PdfProvider | null;
  extractor:    PdfExtractor | null;
  workspaceDir: string;
  sandboxRewrite?: (path: string) => string | undefined;
  mediaStorage?:   MediaStorage;
}

export async function analyzePdf(
  input: AnalyzePdfInput,
  ctx: AnalyzePdfContext,
): Promise<AnalyzePdfOutput | AnalyzePdfError> {
  // 1. Assemble — reuse the image-handler helper. Treats `pdf` / `pdfs`
  //    the same way it treats `image` / `images`.
  const candidates = assembleCandidates({ image: input.pdf, images: input.pdfs });
  if (candidates.length === 0)            return { error: "no_pdfs" };
  if (candidates.length > MAX_PDFS)       return { error: "too_many_pdfs", count: candidates.length };
  if (!ctx.provider)                      return { error: "no_provider" };

  // 2. Resolve each PDF (read into Buffer + base64).
  const resolved: ResolvedPdf[] = [];
  for (const c of candidates) {
    try {
      resolved.push(await resolvePdfOne(c, {
        workspaceDir:   ctx.workspaceDir,
        sandboxRewrite: ctx.sandboxRewrite,
        mediaStorage:   ctx.mediaStorage,
      }));
    } catch (err: unknown) {
      return {
        error: "read_failed",
        path:  c,
        cause: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const prompt    = (input.prompt ?? "Describe the PDF.").trim();
  const hasPages  = typeof input.pages === "string" && input.pages.trim() !== "";
  // Native path is only chosen when the provider supports it AND there's
  // no page range to enforce. Pages always go through the extractor.
  const useNative = !hasPages && typeof ctx.provider.describePdfNative === "function";

  const attempts: Array<{ provider: string; model: string; error?: string }> = [
    { provider: ctx.provider.name, model: ctx.provider.model },
  ];

  // 3. Dispatch.
  let result: DescribeResult;
  try {
    if (useNative) {
      result = await ctx.provider.describePdfNative!(prompt, resolved.map((r) => r.ref));
    } else {
      if (!ctx.extractor) return { error: "no_extractor" };
      const extracted: ExtractedPdf[] = [];
      for (const r of resolved) {
        extracted.push(await ctx.extractor.extract(r.ref.buffer, input.pages));
      }
      result = await ctx.provider.describeExtracted(prompt, extracted);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    attempts[attempts.length - 1]!.error = msg;
    return {
      error:    "model_failed",
      attempts: attempts as Array<{ provider: string; model: string; error: string }>,
    };
  }

  // 4. Build the result. Singular `pdf` when there's one; plural `pdfs`
  //    when there are many, matching the image tool's convention.
  const rewrittenFrom: Record<string, string> = {};
  for (const r of resolved) {
    if (r.rewrittenFrom) rewrittenFrom[r.original] = r.rewrittenFrom;
  }

  const details: AnalyzePdfOutput["details"] = {
    model:    `${ctx.provider.name}/${ctx.provider.model}`,
    native:   useNative,
    attempts,
  };
  if (resolved.length === 1) details.pdf  = resolved[0]!.resolved;
  else                       details.pdfs = resolved.map((r) => r.resolved);
  if (Object.keys(rewrittenFrom).length > 0) details.rewrittenFrom = rewrittenFrom;

  return {
    content: [{ type: "text", text: result.text }],
    details,
  };
}
