import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "grammy/types";
import {
  detectMedia,
  extFromTelegram,
  fetchTelegramFile,
  ingestTelegramMedia,
  buildInboundShape,
} from "@/remote/adapters/telegram-media";
import { MediaStorage } from "@/remote/media-storage";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "nexusclaw-media-tg-"));
}

// ---------------------------------------------------------------------------
// detectMedia
// ---------------------------------------------------------------------------

describe("detectMedia", () => {
  test("picks document over the other fields", () => {
    const m = detectMedia({
      document: { file_id: "doc", file_unique_id: "u", file_name: "x.pdf", mime_type: "application/pdf", file_size: 10 },
    } as unknown as Message);
    expect(m).toEqual({ kind: "document", fileId: "doc", fileName: "x.pdf", mimeType: "application/pdf", fileSize: 10 });
  });

  test("picks the largest variant when only photo is set", () => {
    const m = detectMedia({
      photo: [
        { file_id: "small", file_unique_id: "u1", width: 90,  height: 90,  file_size: 1000 },
        { file_id: "med",   file_unique_id: "u2", width: 320, height: 320, file_size: 5000 },
        { file_id: "big",   file_unique_id: "u3", width: 800, height: 800, file_size: 20000 },
      ],
    } as unknown as Message);
    expect(m).toEqual({ kind: "photo", fileId: "big", fileSize: 20000 });
  });

  test("returns null when there is no media field", () => {
    expect(detectMedia({ text: "hi" } as unknown as Message)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extFromTelegram
// ---------------------------------------------------------------------------

describe("extFromTelegram", () => {
  test("prefers the file_path extension", () => {
    expect(extFromTelegram("photos/file_0.jpg", undefined)).toBe("jpg");
    expect(extFromTelegram("videos/clip.MOV", undefined)).toBe("mov");
  });

  test("falls back to mime type when file_path has no extension", () => {
    expect(extFromTelegram("photos/file_0", "image/png")).toBe("png");
    expect(extFromTelegram(undefined, "application/pdf")).toBe("pdf");
  });

  test("returns '' when nothing helps", () => {
    expect(extFromTelegram(undefined, undefined)).toBe("");
    expect(extFromTelegram("no_extension", "unknown/type")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fetchTelegramFile
// ---------------------------------------------------------------------------

describe("fetchTelegramFile", () => {
  test("calls getFile then downloads via the constructed URL", async () => {
    const calls: { fileId: string; url?: string }[] = [];
    const { bytes, filePath } = await fetchTelegramFile(
      "TOKEN123",
      "file_abc",
      async (id) => { calls.push({ fileId: id }); return { file_path: "photos/x.jpg" }; },
      async (url) => { calls[calls.length - 1]!.url = url; return Buffer.from("bytes"); },
    );
    expect(bytes.toString()).toBe("bytes");
    expect(filePath).toBe("photos/x.jpg");
    expect(calls[0]!.url).toBe("https://api.telegram.org/file/botTOKEN123/photos/x.jpg");
  });

  test("throws when getFile yields no file_path", async () => {
    await expect(
      fetchTelegramFile("T", "f", async () => ({}), async () => Buffer.alloc(0)),
    ).rejects.toThrow(/no file_path/);
  });
});

// ---------------------------------------------------------------------------
// ingestTelegramMedia
// ---------------------------------------------------------------------------

describe("ingestTelegramMedia", () => {
  test("saves bytes to disk and marks small files inline-eligible", async () => {
    const storage = new MediaStorage({ root: freshRoot() });
    const result = await ingestTelegramMedia(
      { kind: "photo", fileId: "file_abc" },
      {
        token:    "T",
        storage,
        getFile:  async () => ({ file_path: "photos/x.png" }),
        download: async () => Buffer.from([1, 2, 3, 4, 5]),
        inlineLimit: 1024,
      },
    );
    expect(result.saved.size).toBe(5);
    expect(result.saved.id).toMatch(/^media---[0-9a-f-]{36}\.png$/);
    expect(result.inlineEligible).toBe(true);
    expect(result.inlineBytes!.toString("hex")).toBe("0102030405");
  });

  test("spills files past the inline limit (marker path)", async () => {
    const storage = new MediaStorage({ root: freshRoot() });
    const result = await ingestTelegramMedia(
      { kind: "document", fileId: "f", fileName: "report.pdf", mimeType: "application/pdf" },
      {
        token:    "T",
        storage,
        getFile:  async () => ({ file_path: "docs/report.pdf" }),
        download: async () => Buffer.alloc(2048),
        inlineLimit: 1024,
      },
    );
    expect(result.inlineEligible).toBe(false);
    expect(result.inlineBytes).toBeNull();
    expect(result.saved.id).toMatch(/^report---[0-9a-f-]{36}\.pdf$/);
    expect(result.saved.mimeType).toBe("application/pdf");
    expect(result.saved.uri).toMatch(/^media:\/\/inbound\/report---/);
  });
});

// ---------------------------------------------------------------------------
// buildInboundShape
// ---------------------------------------------------------------------------

describe("buildInboundShape", () => {
  function fakeIngested(opts: { mime: string; inline: boolean; size?: number }) {
    const id = `media---abcd0000-1111-2222-3333-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
    return {
      saved: {
        id,
        path: `/tmp/${id}`,
        bucket: "inbound" as const,
        size: opts.size ?? 100,
        mimeType: opts.mime,
        uri: `media://inbound/${id}`,
      },
      inlineEligible: opts.inline,
      inlineBytes: opts.inline ? Buffer.from([0xaa, 0xbb]) : null,
    };
  }

  test("inlines small images as image blocks with text first", () => {
    const m = fakeIngested({ mime: "image/jpeg", inline: true });
    const shape = buildInboundShape("look at this", [m]);
    expect(shape.text).toBe("look at this");
    expect(shape.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", data: Buffer.from([0xaa, 0xbb]).toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  test("falls back to marker text for oversized media", () => {
    const m = fakeIngested({ mime: "image/jpeg", inline: false });
    const shape = buildInboundShape("hello", [m]);
    expect(shape.text).toBe(`hello\n[media attached: ${m.saved.uri}]`);
    expect(shape.content).toEqual([]);
  });

  test("non-image media use the marker path even when small enough", () => {
    const m = fakeIngested({ mime: "application/pdf", inline: true });
    const shape = buildInboundShape("read this", [m]);
    expect(shape.content).toEqual([]);
    expect(shape.text).toContain("[media attached:");
  });

  test("media-only inbound emits just the marker", () => {
    const m = fakeIngested({ mime: "video/mp4", inline: false });
    const shape = buildInboundShape("", [m]);
    expect(shape.content).toEqual([]);
    expect(shape.text).toBe(`[media attached: ${m.saved.uri}]`);
  });

  test("text-only inbound returns plain text with empty content", () => {
    const shape = buildInboundShape("just text", []);
    expect(shape).toEqual({ text: "just text", content: [] });
  });
});
