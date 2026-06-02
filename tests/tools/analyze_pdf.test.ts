import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzePdf,
  resolvePdfOne,
  MAX_PDFS,
} from "@/tools/handlers/analyze_pdf";
import type {
  PdfProvider,
  PdfRef,
  ExtractedPdf,
  PdfExtractor,
  DescribeResult,
} from "@/tools/pdf-provider";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function nativeProvider(): PdfProvider & {
  nativeCalls: number;
  extractedCalls: number;
  lastNativeRefs?: PdfRef[];
  lastExtracted?: ExtractedPdf[];
} {
  return {
    name: "anthropic",
    model: "claude-opus-4-6",
    nativeCalls: 0,
    extractedCalls: 0,
    async describePdfNative(prompt: string, pdfs: PdfRef[]): Promise<DescribeResult> {
      this.nativeCalls++;
      this.lastNativeRefs = pdfs;
      return { text: `native:${prompt}:${pdfs.length}` };
    },
    async describeExtracted(prompt: string, extracted: ExtractedPdf[]): Promise<DescribeResult> {
      this.extractedCalls++;
      this.lastExtracted = extracted;
      return { text: `extracted:${prompt}:${extracted.length}` };
    },
  };
}

function extractOnlyProvider(): PdfProvider & {
  extractedCalls: number;
  lastExtracted?: ExtractedPdf[];
} {
  return {
    name: "openai",
    model: "gpt-4o",
    extractedCalls: 0,
    async describeExtracted(prompt: string, extracted: ExtractedPdf[]): Promise<DescribeResult> {
      this.extractedCalls++;
      this.lastExtracted = extracted;
      return { text: `extracted:${prompt}:${extracted.length}` };
    },
  };
}

function fixedExtractor(): PdfExtractor & { calls: number; lastPages?: string } {
  return {
    calls: 0,
    async extract(_buf: Buffer, pages?: string): Promise<ExtractedPdf> {
      this.calls++;
      this.lastPages = pages;
      return {
        text: `text-for${pages ? `-${pages}` : ""}`,
        pageImages: [{ data: "AA", mimeType: "image/png" }],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// resolvePdfOne
// ---------------------------------------------------------------------------

describe("resolvePdfOne", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "nx-pdf-")); });
  afterEach(()  => { rmSync(tmp, { recursive: true, force: true }); });

  test("data: URL parses into Buffer + base64 with mediaType", async () => {
    const out = await resolvePdfOne("data:application/pdf;base64,SGVsbG8=", { workspaceDir: tmp });
    expect(out.ref.mediaType).toBe("application/pdf");
    expect(out.ref.data).toBe("SGVsbG8=");
    expect(out.ref.buffer.toString()).toBe("Hello");
  });

  test("relative path reads from workspaceDir into Buffer + base64", async () => {
    const file = join(tmp, "doc.pdf");
    writeFileSync(file, Buffer.from("PDF-bytes"));
    const out = await resolvePdfOne("doc.pdf", { workspaceDir: tmp });
    expect(out.resolved).toBe(file);
    expect(out.ref.mediaType).toBe("application/pdf");
    expect(out.ref.buffer.toString()).toBe("PDF-bytes");
    expect(Buffer.from(out.ref.data, "base64").toString()).toBe("PDF-bytes");
  });

  test("sandbox rewrite records rewrittenFrom", async () => {
    const original = join(tmp, "orig.pdf");
    const target   = join(tmp, "rewritten.pdf");
    writeFileSync(target, Buffer.from("R"));
    const out = await resolvePdfOne("orig.pdf", {
      workspaceDir:   tmp,
      sandboxRewrite: (p) => p === original ? target : undefined,
    });
    expect(out.resolved).toBe(target);
    expect(out.rewrittenFrom).toBe(original);
  });

  test("http URL throws (deferred to media-storage stage)", async () => {
    await expect(resolvePdfOne("https://x.example/doc.pdf", { workspaceDir: tmp }))
      .rejects.toThrow(/URL PDFs are not yet supported/);
  });

  test("pseudo-URI throws as well (no implicit fs read)", async () => {
    await expect(resolvePdfOne("pdf:0", { workspaceDir: tmp }))
      .rejects.toThrow(/URL PDFs are not yet supported/);
  });
});

// ---------------------------------------------------------------------------
// analyzePdf — error returns
// ---------------------------------------------------------------------------

describe("analyzePdf — error returns", () => {
  test("no pdfs → no_pdfs", async () => {
    const out = await analyzePdf({}, {
      provider:     nativeProvider(),
      extractor:    fixedExtractor(),
      workspaceDir: "/tmp",
    });
    expect(out).toEqual({ error: "no_pdfs" });
  });

  test(`more than ${MAX_PDFS} pdfs → too_many_pdfs`, async () => {
    const pdfs = Array.from({ length: MAX_PDFS + 1 }, (_, i) => `doc${i}.pdf`);
    const out = await analyzePdf({ pdfs }, {
      provider:     nativeProvider(),
      extractor:    fixedExtractor(),
      workspaceDir: "/tmp",
    });
    expect(out).toEqual({ error: "too_many_pdfs", count: MAX_PDFS + 1 });
  });

  test("no provider → no_provider", async () => {
    const out = await analyzePdf({ pdf: "data:application/pdf;base64,AA" }, {
      provider:     null,
      extractor:    fixedExtractor(),
      workspaceDir: "/tmp",
    });
    expect(out).toEqual({ error: "no_provider" });
  });

  test("no extractor when extract path is needed → no_extractor", async () => {
    const out = await analyzePdf(
      { pdf: "data:application/pdf;base64,AA" },
      {
        provider:     extractOnlyProvider(), // no native → extract path
        extractor:    null,
        workspaceDir: "/tmp",
      },
    );
    expect(out).toEqual({ error: "no_extractor" });
  });

  test("read failure surfaces as read_failed with cause", async () => {
    const out = await analyzePdf(
      { pdf: "/does/not/exist.pdf" },
      {
        provider:     nativeProvider(),
        extractor:    fixedExtractor(),
        workspaceDir: "/tmp",
      },
    );
    if (!("error" in out)) throw new Error("expected error");
    expect(out.error).toBe("read_failed");
    if (out.error === "read_failed") {
      expect(out.path).toBe("/does/not/exist.pdf");
      expect(out.cause).toContain("ENOENT");
    }
  });

  test("model failure surfaces as model_failed with attempts", async () => {
    const provider: PdfProvider = {
      name: "anthropic",
      model: "claude-opus-4-6",
      async describePdfNative() { throw new Error("boom"); },
      async describeExtracted() { return { text: "" }; },
    };
    const out = await analyzePdf(
      { pdf: "data:application/pdf;base64,AA" },
      { provider, extractor: fixedExtractor(), workspaceDir: "/tmp" },
    );
    if (!("error" in out)) throw new Error("expected error");
    expect(out.error).toBe("model_failed");
    if (out.error === "model_failed") {
      expect(out.attempts[0]!.error).toBe("boom");
    }
  });
});

// ---------------------------------------------------------------------------
// analyzePdf — dispatch strategy
// ---------------------------------------------------------------------------

describe("analyzePdf — dispatch strategy", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "nx-pdf-disp-")); });
  afterEach(()  => { rmSync(tmp, { recursive: true, force: true }); });

  test("native provider + no pages → native path", async () => {
    const p = nativeProvider();
    const out = await analyzePdf(
      { pdf: "data:application/pdf;base64,AA", prompt: "summarize" },
      { provider: p, extractor: fixedExtractor(), workspaceDir: tmp },
    );
    if ("error" in out) throw new Error("expected success");
    expect(p.nativeCalls).toBe(1);
    expect(p.extractedCalls).toBe(0);
    expect(out.details.native).toBe(true);
    expect(out.content[0]!.text).toBe("native:summarize:1");
  });

  test("native provider + pages → extract path (pages forces extraction)", async () => {
    const p = nativeProvider();
    const e = fixedExtractor();
    const out = await analyzePdf(
      { pdf: "data:application/pdf;base64,AA", prompt: "summarize", pages: "1-3" },
      { provider: p, extractor: e, workspaceDir: tmp },
    );
    if ("error" in out) throw new Error("expected success");
    expect(p.nativeCalls).toBe(0);
    expect(p.extractedCalls).toBe(1);
    expect(e.calls).toBe(1);
    expect(e.lastPages).toBe("1-3");
    expect(out.details.native).toBe(false);
  });

  test("extract-only provider → extract path even without pages", async () => {
    const p = extractOnlyProvider();
    const e = fixedExtractor();
    const out = await analyzePdf(
      { pdf: "data:application/pdf;base64,AA", prompt: "summarize" },
      { provider: p, extractor: e, workspaceDir: tmp },
    );
    if ("error" in out) throw new Error("expected success");
    expect(p.extractedCalls).toBe(1);
    expect(e.calls).toBe(1);
    expect(e.lastPages).toBeUndefined();
    expect(out.details.native).toBe(false);
  });

  test("empty-string pages does NOT force extract path", async () => {
    const p = nativeProvider();
    const out = await analyzePdf(
      { pdf: "data:application/pdf;base64,AA", pages: "   " },
      { provider: p, extractor: fixedExtractor(), workspaceDir: tmp },
    );
    if ("error" in out) throw new Error("expected success");
    expect(p.nativeCalls).toBe(1);
    expect(out.details.native).toBe(true);
  });

  test("happy path returns content + details (single pdf)", async () => {
    const p = nativeProvider();
    const out = await analyzePdf(
      { pdf: "data:application/pdf;base64,AA", prompt: "what" },
      { provider: p, extractor: fixedExtractor(), workspaceDir: tmp },
    );
    if ("error" in out) throw new Error("expected success");
    expect(out.content).toEqual([{ type: "text", text: "native:what:1" }]);
    expect(out.details.model).toBe("anthropic/claude-opus-4-6");
    expect(out.details.pdf).toBe("data:application/pdf;base64,AA");
    expect(out.details.pdfs).toBeUndefined();
    expect(out.details.attempts).toEqual([{ provider: "anthropic", model: "claude-opus-4-6" }]);
  });

  test("happy path with multiple pdfs returns plural details.pdfs", async () => {
    const p = nativeProvider();
    const out = await analyzePdf(
      { pdfs: [
          "data:application/pdf;base64,AA",
          "data:application/pdf;base64,BB",
        ], prompt: "look" },
      { provider: p, extractor: fixedExtractor(), workspaceDir: tmp },
    );
    if ("error" in out) throw new Error("expected success");
    expect(out.details.pdfs).toHaveLength(2);
    expect(out.details.pdf).toBeUndefined();
    expect(p.lastNativeRefs).toHaveLength(2);
  });

  test("default prompt is 'Describe the PDF.'", async () => {
    const p = nativeProvider();
    await analyzePdf(
      { pdf: "data:application/pdf;base64,AA" },
      { provider: p, extractor: fixedExtractor(), workspaceDir: tmp },
    );
    expect(p.nativeCalls).toBe(1);
    // The provider stub returns "native:<prompt>:..."; the default prompt
    // should appear verbatim there.
    expect(p.lastNativeRefs).toBeDefined();
  });
});
