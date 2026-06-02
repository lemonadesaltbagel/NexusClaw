import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  assembleCandidates,
  classifyImage,
  resolveOne,
  resolveUserPath,
  describeWithStrategy,
  analyzeImage,
  MAX_IMAGES,
  type ImageKind,
} from "@/tools/handlers/analyze_image";
import type { ImageProvider, ImageRef, DescribeResult } from "@/tools/image-provider";

// ---------------------------------------------------------------------------
// assembleCandidates
// ---------------------------------------------------------------------------

describe("assembleCandidates", () => {
  test("merges single + array, preserves order", () => {
    expect(assembleCandidates({ image: "a", images: ["b", "c"] })).toEqual(["a", "b", "c"]);
  });
  test("strips leading @ and trims whitespace", () => {
    expect(assembleCandidates({ images: ["  @foo  ", "  bar"] })).toEqual(["foo", "bar"]);
  });
  test("dedupes while preserving first occurrence", () => {
    expect(assembleCandidates({ images: ["a", "b", "a", "c", "b"] })).toEqual(["a", "b", "c"]);
  });
  test("drops empties and ignores non-strings safely", () => {
    expect(assembleCandidates({ images: ["", "  ", "x"] as string[] })).toEqual(["x"]);
  });
  test("works with image only / images only / neither", () => {
    expect(assembleCandidates({ image: "only" })).toEqual(["only"]);
    expect(assembleCandidates({ images: ["a"] })).toEqual(["a"]);
    expect(assembleCandidates({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyImage — the five regex shapes
// ---------------------------------------------------------------------------

describe("classifyImage", () => {
  const cases: Array<[string, ImageKind]> = [
    ["data:image/png;base64,abc",      "data-url"],
    ["file:///tmp/x.png",              "file-url"],
    ["https://example.com/x.png",      "http-url"],
    ["http://example.com/x.png",       "http-url"],
    ["C:\\Users\\me\\img.png",         "windows-path"],
    ["c:/users/me/img.png",            "windows-path"],
    ["~/Pictures/x.png",               "home-path"],
    ["/abs/path/img.png",              "absolute-path"],
    ["relative/path.png",              "relative-path"],
    ["just-a-filename.png",            "relative-path"],
    ["image:0",                        "pseudo-uri"],
    ["blob:something",                 "pseudo-uri"],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" → ${expected}`, () => {
      expect(classifyImage(input)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// resolveUserPath
// ---------------------------------------------------------------------------

describe("resolveUserPath", () => {
  test("expands ~ to homedir", () => {
    expect(resolveUserPath("~")).toBe(homedir());
  });
  test("expands ~/x to homedir/x", () => {
    expect(resolveUserPath("~/Pictures/x.png")).toBe(join(homedir(), "Pictures", "x.png"));
  });
  test("non-~ paths pass through unchanged", () => {
    expect(resolveUserPath("/abs/path")).toBe("/abs/path");
    expect(resolveUserPath("relative")).toBe("relative");
  });
});

// ---------------------------------------------------------------------------
// resolveOne — disk reads + URL passthrough
// ---------------------------------------------------------------------------

describe("resolveOne", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "nx-analyze-")); });
  afterEach(()  => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("data: URL parses into base64 ref with media type", async () => {
    const out = await resolveOne("data:image/png;base64,SGVsbG8=", { workspaceDir: tmpDir });
    expect(out.ref).toEqual({ kind: "base64", mediaType: "image/png", data: "SGVsbG8=" });
  });

  test("http URL passes through as url ref", async () => {
    const out = await resolveOne("https://x.example/cat.jpg", { workspaceDir: tmpDir });
    expect(out.ref).toEqual({ kind: "url", url: "https://x.example/cat.jpg" });
  });

  test("pseudo-URI passes through as url ref (does NOT hit the filesystem)", async () => {
    // If this tried fs.readFile("image:0") the test would throw ENOENT —
    // the entire point of pseudo-URI handling.
    const out = await resolveOne("image:0", { workspaceDir: tmpDir });
    expect(out.ref).toEqual({ kind: "url", url: "image:0" });
  });

  test("relative path resolves against workspaceDir", async () => {
    const file = join(tmpDir, "in.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));   // PNG header
    const out = await resolveOne("in.png", { workspaceDir: tmpDir });
    expect(out.ref.kind).toBe("base64");
    if (out.ref.kind === "base64") {
      expect(out.ref.mediaType).toBe("image/png");
    }
    expect(out.resolved).toBe(file);
  });

  test("sandbox rewrite records rewrittenFrom", async () => {
    const original = join(tmpDir, "orig.png");
    const target   = join(tmpDir, "rewritten.png");
    writeFileSync(target, Buffer.from([1, 2, 3]));
    const out = await resolveOne("orig.png", {
      workspaceDir:   tmpDir,
      sandboxRewrite: (p) => p === original ? target : undefined,
    });
    expect(out.resolved).toBe(target);
    expect(out.rewrittenFrom).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// describeWithStrategy — single / batch / loop
// ---------------------------------------------------------------------------

function singleOnlyProvider(): ImageProvider & {
  describeImageCalls: number;
  describeImagesCalls: number;
} {
  let s = 0;
  return {
    name: "fake", model: "test-model",
    describeImageCalls:  0,
    describeImagesCalls: 0,
    async describeImage(prompt: string, _i: ImageRef): Promise<DescribeResult> {
      this.describeImageCalls++;
      return { text: `[${++s}] ${prompt}` };
    },
  };
}

function batchProvider(): ImageProvider & { describeImagesCalls: number; describeImageCalls: number } {
  return {
    name: "fake", model: "test-model",
    describeImageCalls:  0,
    describeImagesCalls: 0,
    async describeImage(prompt: string, _i: ImageRef): Promise<DescribeResult> {
      this.describeImageCalls++;
      return { text: prompt };
    },
    async describeImages(_p: string, refs: ImageRef[]): Promise<DescribeResult> {
      this.describeImagesCalls++;
      return { text: `batch ${refs.length}` };
    },
  };
}

describe("describeWithStrategy", () => {
  const png: ImageRef = { kind: "base64", mediaType: "image/png", data: "AA" };

  test("one image → describeImage()", async () => {
    const p = singleOnlyProvider();
    await describeWithStrategy(p, "look", [png]);
    expect(p.describeImageCalls).toBe(1);
  });

  test("many images + native batch → describeImages() called once", async () => {
    const p = batchProvider();
    await describeWithStrategy(p, "look", [png, png, png]);
    expect(p.describeImagesCalls).toBe(1);
    expect(p.describeImageCalls).toBe(0);
  });

  test("many images + single-only → loop with 'Describe N of M.' prefix", async () => {
    const p = singleOnlyProvider();
    const r = await describeWithStrategy(p, "look", [png, png, png]);
    expect(p.describeImageCalls).toBe(3);
    expect(r.text).toContain("Image 1:");
    expect(r.text).toContain("Image 2:");
    expect(r.text).toContain("Image 3:");
    // The prefix should appear in the per-call prompt — we put it in the response text.
    expect(r.text).toContain("Describe image 1 of 3");
    expect(r.text).toContain("Describe image 3 of 3");
  });
});

// ---------------------------------------------------------------------------
// analyzeImage — end-to-end errors
// ---------------------------------------------------------------------------

describe("analyzeImage — error returns", () => {
  test("no images → no_images error", async () => {
    const out = await analyzeImage({}, { provider: singleOnlyProvider(), workspaceDir: "/tmp" });
    expect(out).toEqual({ error: "no_images" });
  });

  test(`more than ${MAX_IMAGES} images → too_many_images error`, async () => {
    const list = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => `img${i}.png`);
    const out = await analyzeImage({ images: list }, { provider: singleOnlyProvider(), workspaceDir: "/tmp" });
    expect(out).toEqual({ error: "too_many_images", count: MAX_IMAGES + 1 });
  });

  test("no provider → no_provider error", async () => {
    const out = await analyzeImage({ image: "https://x" }, { provider: null, workspaceDir: "/tmp" });
    expect(out).toEqual({ error: "no_provider" });
  });

  test("happy path returns content[0].text + details", async () => {
    const p = batchProvider();
    const out = await analyzeImage(
      { image: "https://x.example/cat.jpg", prompt: "what" },
      { provider: p, workspaceDir: "/tmp" },
    );
    if ("error" in out) throw new Error("expected success");
    expect(out.content).toEqual([{ type: "text", text: "what" }]);
    expect(out.details.model).toBe("fake/test-model");
    expect(out.details.images).toEqual(["https://x.example/cat.jpg"]);
    expect(out.details.attempts).toEqual([{ provider: "fake", model: "test-model" }]);
  });

  test("read failure surfaces as read_failed with cause", async () => {
    const out = await analyzeImage(
      { image: "/does/not/exist.png" },
      { provider: singleOnlyProvider(), workspaceDir: "/tmp" },
    );
    if (!("error" in out)) throw new Error("expected error");
    expect(out.error).toBe("read_failed");
    if (out.error === "read_failed") {
      expect(out.path).toBe("/does/not/exist.png");
      expect(out.cause).toContain("ENOENT");
    }
  });
});
