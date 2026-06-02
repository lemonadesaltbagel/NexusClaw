// ---------------------------------------------------------------------------
// analyze_image — describe one or more images with a vision model.
//
// Inputs (the tool accepts EITHER shape; both are optional individually):
//   * image:  string                 — single path / URL / data URL
//   * images: string[]               — multiple sources (≤ 20)
//   * prompt: string                 — instruction passed to the model
//
// Pipeline:
//   1. Assemble        — merge image + images; trim; strip leading "@";
//                        dedupe preserving order; cap at 20 (silent error).
//   2. Classify        — for each entry, decide if it's an HTTP/data/file
//                        URL, a Windows path, a "~/…" home path, an
//                        agent-side pseudo-URI (e.g. "image:0"), or a
//                        plain relative path.
//   3. Resolve         — turn each into either a `url` or a `base64`
//                        ImageRef, reading from disk where appropriate.
//   4. Dispatch        — call the resolved provider:
//                        single image   → describeImage
//                        many + batch   → describeImages (one call)
//                        many + single  → loop with "Describe N of M."
//   5. Build result    — { content: [{type:"text", text}], details: {…} }
//                        where details survives in-memory for future use.
// ---------------------------------------------------------------------------

import { readFile, statSync } from "node:fs";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve as resolvePath, isAbsolute } from "node:path";
import type { ImageProvider, ImageRef, DescribeResult } from "@/tools/image-provider";

const readFileAsync = promisify(readFile);

// Bot API limit + a margin for caption / metadata.
export const MAX_IMAGES = 20;

export interface AnalyzeImageInput {
  image?:  string;
  images?: string[];
  prompt?: string;
}

export interface AnalyzeImageOutput {
  content: Array<{ type: "text"; text: string }>;
  details: {
    model:          string;             // "provider/model"
    images:         string[];           // resolved sources actually used
    rewrittenFrom?: Record<string, string>;
    attempts:       Array<{ provider: string; model: string; error?: string }>;
  };
}

export type AnalyzeImageError =
  | { error: "too_many_images";   count: number }
  | { error: "no_images" }
  | { error: "no_provider" }
  | { error: "read_failed";       path: string; cause: string }
  | { error: "model_failed";      attempts: Array<{ provider: string; model: string; error: string }> };

// ---------------------------------------------------------------------------
// Step 1 — assemble candidate list
// ---------------------------------------------------------------------------

export function assembleCandidates(input: AnalyzeImageInput): string[] {
  const raw: string[] = [];
  if (typeof input.image  === "string") raw.push(input.image);
  if (Array.isArray(input.images)) for (const i of input.images) if (typeof i === "string") raw.push(i);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    let s = r.trim();
    if (s.startsWith("@")) s = s.slice(1);
    s = s.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 2 — classify the path / URL / scheme shape
// ---------------------------------------------------------------------------

export type ImageKind =
  | "data-url"
  | "file-url"
  | "http-url"
  | "windows-path"
  | "home-path"
  | "absolute-path"
  | "relative-path"
  | "pseudo-uri";   // e.g. "image:0" — agent-side reference, ignored here

export function classifyImage(raw: string): ImageKind {
  const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(raw);
  const isFileUrl   = /^file:/i.test(raw);
  const isHttpUrl   = /^https?:\/\//i.test(raw);
  const isDataUrl   = /^data:/i.test(raw);
  const hasScheme   = /^[a-z][a-z0-9+.-]*:/i.test(raw);

  if (isDataUrl)              return "data-url";
  if (isFileUrl)              return "file-url";
  if (isHttpUrl)              return "http-url";
  if (looksLikeWindowsDrivePath) return "windows-path";
  if (raw.startsWith("~"))    return "home-path";
  // A scheme that's not file://, http://, or data: is an agent-side
  // pseudo-URI (e.g. "image:0", "blob:…"). Hand it back to the caller
  // unchanged — otherwise fs.readFile("image:0") would emit ENOENT.
  if (hasScheme)              return "pseudo-uri";
  if (isAbsolute(raw))        return "absolute-path";
  return "relative-path";
}

// ---------------------------------------------------------------------------
// Step 3 — resolve each candidate to an ImageRef (url or base64)
// ---------------------------------------------------------------------------

export interface ResolveContext {
  workspaceDir: string;
  /** Optional sandbox rewrite (records the mapping in details if used). */
  sandboxRewrite?: (path: string) => string | undefined;
}

export interface ResolvedImage {
  ref:          ImageRef;
  /** Original input string before any classification / rewrite. */
  original:     string;
  /** Path or URL actually used to resolve. */
  resolved:     string;
  /** Set when the sandbox rewrote the path. */
  rewrittenFrom?: string;
}

/** Resolve "~/x" → "/home/user/x" without depending on shelljs. */
export function resolveUserPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return resolvePath(homedir(), p.slice(2));
  }
  return p;
}

function guessMediaType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png"))           return "image/png";
  if (lower.endsWith(".gif"))           return "image/gif";
  if (lower.endsWith(".webp"))          return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

export async function resolveOne(
  raw: string,
  ctx: ResolveContext,
): Promise<ResolvedImage> {
  const kind = classifyImage(raw);

  if (kind === "data-url") {
    // data:image/png;base64,XXXX → split into media-type + payload
    const m = raw.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
    const mediaType = m?.[1] ?? "image/jpeg";
    const data      = m?.[2] ?? "";
    return {
      ref:      { kind: "base64", mediaType, data },
      original: raw,
      resolved: raw,
    };
  }

  if (kind === "http-url") {
    return { ref: { kind: "url", url: raw }, original: raw, resolved: raw };
  }

  if (kind === "file-url") {
    // file:///abs/path — strip the scheme, read the file.
    const path = raw.replace(/^file:\/{2,3}/i, "/");
    return await readAsBase64(raw, path);
  }

  if (kind === "pseudo-uri") {
    // Don't touch the filesystem. Caller decides how to interpret it; we
    // pass it through as a URL ref so the model gets the raw string and
    // can ignore / hallucinate-around it.
    return { ref: { kind: "url", url: raw }, original: raw, resolved: raw };
  }

  // Filesystem paths from here on.
  let path = raw;
  if (kind === "home-path") {
    path = resolveUserPath(raw);
  } else if (kind === "relative-path") {
    path = resolvePath(ctx.workspaceDir, raw);
  }

  let rewrittenFrom: string | undefined;
  if (ctx.sandboxRewrite) {
    const rewritten = ctx.sandboxRewrite(path);
    if (rewritten && rewritten !== path) {
      rewrittenFrom = path;
      path = rewritten;
    }
  }
  return await readAsBase64(raw, path, rewrittenFrom);
}

async function readAsBase64(
  original: string,
  path: string,
  rewrittenFrom?: string,
): Promise<ResolvedImage> {
  const buf = await readFileAsync(path);
  return {
    ref: {
      kind:      "base64",
      mediaType: guessMediaType(path),
      data:      buf.toString("base64"),
    },
    original,
    resolved: path,
    rewrittenFrom,
  };
}

// ---------------------------------------------------------------------------
// Step 4 — dispatch with single / batch / loop strategy
// ---------------------------------------------------------------------------

export async function describeWithStrategy(
  provider: ImageProvider,
  prompt: string,
  refs: ImageRef[],
): Promise<DescribeResult> {
  if (refs.length === 1) {
    return await provider.describeImage(prompt, refs[0]!);
  }
  if (provider.describeImages) {
    return await provider.describeImages(prompt, refs);
  }
  // Fallback loop. Prefix each prompt; concatenate results with headers.
  const parts: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    const sub = `Describe image ${i + 1} of ${refs.length}. ${prompt}`;
    const r = await provider.describeImage(sub, refs[i]!);
    parts.push(`Image ${i + 1}: ${r.text}`);
  }
  return { text: parts.join("\n\n") };
}

// ---------------------------------------------------------------------------
// Step 5 — the handler. Composes 1–5 above with structured error returns.
// ---------------------------------------------------------------------------

export interface AnalyzeImageContext {
  provider:    ImageProvider | null;
  workspaceDir: string;
  sandboxRewrite?: (path: string) => string | undefined;
}

export async function analyzeImage(
  input: AnalyzeImageInput,
  ctx: AnalyzeImageContext,
): Promise<AnalyzeImageOutput | AnalyzeImageError> {
  const candidates = assembleCandidates(input);
  if (candidates.length === 0) return { error: "no_images" };
  if (candidates.length > MAX_IMAGES) return { error: "too_many_images", count: candidates.length };
  if (!ctx.provider) return { error: "no_provider" };

  // Resolve everything before calling the model.
  const resolved: ResolvedImage[] = [];
  for (const c of candidates) {
    try {
      resolved.push(await resolveOne(c, {
        workspaceDir:    ctx.workspaceDir,
        sandboxRewrite:  ctx.sandboxRewrite,
      }));
    } catch (err: unknown) {
      return {
        error: "read_failed",
        path:  c,
        cause: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const prompt = (input.prompt ?? "Describe the image.").trim();
  const refs   = resolved.map((r) => r.ref);

  const attempts: Array<{ provider: string; model: string; error?: string }> = [
    { provider: ctx.provider.name, model: ctx.provider.model },
  ];

  let result: DescribeResult;
  try {
    result = await describeWithStrategy(ctx.provider, prompt, refs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    attempts[attempts.length - 1]!.error = msg;
    return { error: "model_failed", attempts: attempts as Array<{ provider: string; model: string; error: string }> };
  }

  const rewrittenFrom: Record<string, string> = {};
  for (const r of resolved) {
    if (r.rewrittenFrom) rewrittenFrom[r.original] = r.rewrittenFrom;
  }

  const details: AnalyzeImageOutput["details"] = {
    model:    `${ctx.provider.name}/${ctx.provider.model}`,
    images:   resolved.map((r) => r.resolved),
    attempts,
  };
  if (Object.keys(rewrittenFrom).length > 0) details.rewrittenFrom = rewrittenFrom;

  return {
    content: [{ type: "text", text: result.text }],
    details,
  };
}

// Re-export for tests
export { statSync };
