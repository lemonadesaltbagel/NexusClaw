import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaStorage,
  sanitizeOriginalName,
  normalizeExtension,
  mimeFromExtension,
  MEDIA_URI_PREFIX,
} from "@/remote/media-storage";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "nexusclaw-media-"));
}

describe("sanitizeOriginalName", () => {
  test("strips unsafe characters and collapses runs of underscores", () => {
    expect(sanitizeOriginalName("hello world!@#$%.jpg")).toBe("hello_world");
    // Path-traversal attempts get reduced to safe characters; slashes become
    // underscores. The lastIndexOf-based extension split only strips after
    // the last dot, leaving a harmless-looking but path-free remainder.
    expect(sanitizeOriginalName("evil/../foo.jpg")).toBe("evil_.._foo");
  });

  test("falls back to 'media' when input is empty / all-stripped", () => {
    expect(sanitizeOriginalName("")).toBe("media");
    expect(sanitizeOriginalName(undefined)).toBe("media");
    expect(sanitizeOriginalName("///!!!")).toBe("media");
  });

  test("truncates very long names", () => {
    const long = "a".repeat(200) + ".jpg";
    const out = sanitizeOriginalName(long);
    expect(out.length).toBeLessThanOrEqual(64);
  });

  test("drops only the trailing extension, not internal dots", () => {
    expect(sanitizeOriginalName("my.file.name.jpg")).toBe("my.file.name");
  });
});

describe("normalizeExtension / mimeFromExtension", () => {
  test("strips dot, lowercases, drops junk", () => {
    expect(normalizeExtension(".JPG")).toBe("jpg");
    expect(normalizeExtension("PNG")).toBe("png");
    expect(normalizeExtension(".tar.gz!")).toBe("tar.gz");
    expect(normalizeExtension("!@#")).toBe("");
    expect(normalizeExtension(undefined)).toBe("");
  });

  test("maps known extensions to mime types", () => {
    expect(mimeFromExtension("jpg")).toBe("image/jpeg");
    expect(mimeFromExtension("png")).toBe("image/png");
    expect(mimeFromExtension("pdf")).toBe("application/pdf");
    expect(mimeFromExtension("bin")).toBe("application/octet-stream");
  });
});

describe("MediaStorage.save", () => {
  test("writes bytes with sanitized-name + UUID + extension", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root });
    const saved = s.save("inbound", "IMG 0042!.JPG", ".jpg", Buffer.from("data"));
    expect(saved.bucket).toBe("inbound");
    expect(saved.id).toMatch(/^IMG_0042---[0-9a-f-]{36}\.jpg$/);
    expect(saved.path.endsWith(saved.id)).toBe(true);
    expect(saved.size).toBe(4);
    expect(saved.mimeType).toBe("image/jpeg");
    expect(saved.uri).toBe(`${MEDIA_URI_PREFIX}inbound/${saved.id}`);
    expect(existsSync(saved.path)).toBe(true);
    expect(readFileSync(saved.path).toString()).toBe("data");
  });

  test("falls back to 'media' when no original name supplied", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root });
    const saved = s.save("inbound", undefined, "png", Buffer.from("x"));
    expect(saved.id).toMatch(/^media---[0-9a-f-]{36}\.png$/);
  });

  test("two saves with the same original name produce distinct ids", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root });
    const a = s.save("inbound", "doc.pdf", "pdf", Buffer.from("a"));
    const b = s.save("inbound", "doc.pdf", "pdf", Buffer.from("b"));
    expect(a.id).not.toBe(b.id);
    expect(a.path).not.toBe(b.path);
  });
});

describe("MediaStorage.sweepExpired", () => {
  test("removes only files older than the TTL", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root, ttlMs: 60_000 });
    const fresh = s.save("inbound", "fresh.png", "png", Buffer.from("a"));
    const stale = s.save("inbound", "stale.png", "png", Buffer.from("b"));

    // Backdate the stale file's mtime past the TTL.
    const old = Date.now() / 1000 - 600;
    utimesSync(stale.path, old, old);

    const removed = s.sweepExpired();
    expect(removed).toBe(1);
    expect(existsSync(fresh.path)).toBe(true);
    expect(existsSync(stale.path)).toBe(false);
  });

  test("save() implicitly sweeps stale files first", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root, ttlMs: 60_000 });
    const stale = s.save("inbound", "stale.png", "png", Buffer.from("a"));
    const old = Date.now() / 1000 - 600;
    utimesSync(stale.path, old, old);

    // The next save triggers cleanup.
    s.save("inbound", "fresh.png", "png", Buffer.from("b"));
    expect(existsSync(stale.path)).toBe(false);
  });

  test("missing bucket directory is not an error", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root });
    // No saves yet — directories don't exist.
    expect(s.sweepExpired()).toBe(0);
  });
});

describe("MediaStorage.resolveUri", () => {
  test("turns a media:// URI into an absolute path", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root });
    const saved = s.save("inbound", "a.png", "png", Buffer.from("x"));
    expect(s.resolveUri(saved.uri)).toBe(saved.path);
  });

  test("rejects malformed or escape-attempting URIs", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root });
    expect(s.resolveUri("file:///etc/passwd")).toBeNull();
    expect(s.resolveUri("media://inbound/")).toBeNull();
    expect(s.resolveUri("media://other/id.png")).toBeNull();
    expect(s.resolveUri("media://inbound/..%2Fescape.png")).toBeNull();
    expect(s.resolveUri("media://inbound/sub/file.png")).toBeNull();
  });

  test("returns null when the file no longer exists on disk", () => {
    const root = freshRoot();
    const s = new MediaStorage({ root });
    expect(s.resolveUri(`${MEDIA_URI_PREFIX}inbound/ghost---11111111-1111-1111-1111-111111111111.png`)).toBeNull();
  });
});
