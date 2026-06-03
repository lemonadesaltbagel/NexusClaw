import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeOutboundMedia,
  looksLikeUrl,
  extFromContentType,
  type OutboundMedia,
} from "@/remote/outbound-media";
import { MediaStorage } from "@/remote/media-storage";

function fixtureStorage(): MediaStorage {
  return new MediaStorage({ root: mkdtempSync(join(tmpdir(), "nx-outbound-")) });
}

describe("looksLikeUrl", () => {
  test("matches http, https, and data URIs", () => {
    expect(looksLikeUrl("https://example.com/x.png")).toBe(true);
    expect(looksLikeUrl("http://example.com/y.jpg")).toBe(true);
    expect(looksLikeUrl("data:image/png;base64,AAA")).toBe(true);
  });

  test("does not match plain paths or other schemes", () => {
    expect(looksLikeUrl("/abs/path.png")).toBe(false);
    expect(looksLikeUrl("relative/x.jpg")).toBe(false);
    expect(looksLikeUrl("media://inbound/x.png")).toBe(false);
    expect(looksLikeUrl("file:///x.png")).toBe(false);
  });
});

describe("extFromContentType", () => {
  test("maps common types to short extensions", () => {
    expect(extFromContentType("image/png")).toBe("png");
    expect(extFromContentType("audio/ogg")).toBe("ogg");
    expect(extFromContentType("application/pdf")).toBe("pdf");
  });

  test("returns '' when unknown or missing", () => {
    expect(extFromContentType(undefined)).toBe("");
    expect(extFromContentType("unknown/x")).toBe("");
  });
});

describe("normalizeOutboundMedia — URL inputs pass through", () => {
  test("bare http(s) string short-circuits to url kind with sniffed contentType", () => {
    const storage = fixtureStorage();
    const out = normalizeOutboundMedia(
      [
        "https://cdn.example.com/cat.jpg",
        "https://cdn.example.com/no-ext",
        "data:image/png;base64,abc",
      ],
      { storage },
    );
    expect(out).toEqual([
      { kind: "url", url: "https://cdn.example.com/cat.jpg", role: "auto", contentType: "image/jpeg" },
      { kind: "url", url: "https://cdn.example.com/no-ext",  role: "auto" },
      { kind: "url", url: "data:image/png;base64,abc",       role: "auto" },
    ]);
  });

  test("explicit url object preserves contentType / fileName / role", () => {
    const storage = fixtureStorage();
    const out = normalizeOutboundMedia(
      [{ kind: "url", url: "https://x/a.gif", contentType: "image/gif", fileName: "a.gif", role: "animation" }],
      { storage },
    );
    expect(out[0]).toEqual({
      kind:        "url",
      url:         "https://x/a.gif",
      contentType: "image/gif",
      fileName:    "a.gif",
      role:        "animation",
    });
  });
});

describe("normalizeOutboundMedia — path inputs copy to outbound/", () => {
  test("string path is read and re-saved", () => {
    const storage = fixtureStorage();
    const dir = mkdtempSync(join(tmpdir(), "nx-src-"));
    const src = join(dir, "drawing.png");
    writeFileSync(src, Buffer.from([1, 2, 3, 4]));

    const out = normalizeOutboundMedia([src], { storage });
    expect(out).toHaveLength(1);
    const m = out[0]! as Extract<OutboundMedia, { kind: "file" }>;
    expect(m.kind).toBe("file");
    expect(m.path).not.toBe(src); // must live under storage, not the source
    expect(m.path).toContain("/outbound/");
    expect(m.contentType).toBe("image/png");
    expect(m.fileName).toBe("drawing.png");
    expect(readFileSync(m.path)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("explicit path object respects supplied contentType + role", () => {
    const storage = fixtureStorage();
    const dir = mkdtempSync(join(tmpdir(), "nx-src-"));
    const src = join(dir, "thing.bin");
    writeFileSync(src, Buffer.from([9, 9]));
    const out = normalizeOutboundMedia(
      [{ kind: "path", path: src, contentType: "video/mp4", role: "video", fileName: "clip.mp4" }],
      { storage },
    );
    const m = out[0]! as Extract<OutboundMedia, { kind: "file" }>;
    expect(m.contentType).toBe("video/mp4");
    expect(m.role).toBe("video");
    expect(m.fileName).toBe("clip.mp4");
  });
});

describe("normalizeOutboundMedia — buffer inputs write bytes", () => {
  test("buffer is saved with sanitized name and the content type is preserved", () => {
    const storage = fixtureStorage();
    const out = normalizeOutboundMedia(
      [{ kind: "buffer", data: Buffer.from("hi"), contentType: "image/jpeg", fileName: "selfie.jpg", role: "photo" }],
      { storage },
    );
    const m = out[0]! as Extract<OutboundMedia, { kind: "file" }>;
    expect(m.kind).toBe("file");
    expect(m.contentType).toBe("image/jpeg");
    expect(m.role).toBe("photo");
    expect(m.fileName).toBe("selfie.jpg");
    expect(readFileSync(m.path).toString()).toBe("hi");
    expect(m.path).toMatch(/selfie---[0-9a-f-]{36}\.jpg$/);
  });

  test("buffer without an explicit fileName falls back to 'output' + uuid", () => {
    const storage = fixtureStorage();
    const out = normalizeOutboundMedia(
      [{ kind: "buffer", data: Buffer.from([0]), contentType: "application/pdf" }],
      { storage },
    );
    const m = out[0]! as Extract<OutboundMedia, { kind: "file" }>;
    expect(m.path).toMatch(/output---[0-9a-f-]{36}\.pdf$/);
  });
});
