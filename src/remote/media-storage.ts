// ---------------------------------------------------------------------------
// Media storage — shared on-disk staging area for inbound user attachments
// and outbound generated media. The agent and every adapter read/write
// against the same paths so a Telegram photo, a Slack upload, or a web
// paste land in the same place and surface to the model the same way.
//
//   ~/.nexusclaw/
//   └── media/
//       ├── inbound/   ← user attachments (Telegram photo, paste, upload)
//       └── outbound/  ← generated images, model outputs
//
// Naming: {sanitized_original_name}---{uuid}.{ext}
//   IMG_0042.jpg → IMG_0042---a1b2c3d4-e5f6-….jpg
//
// TTL: a 2-minute on-disk window. Each save() triggers a sweep that drops
// older files. There is no background timer — cleanup is opportunistic,
// piggy-backing on the next ingest. Files the agent still wants survive
// for the duration of the active turn; everything past 2 min is stale.
// ---------------------------------------------------------------------------

import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Paths + tunables
// ---------------------------------------------------------------------------

export const DEFAULT_MEDIA_ROOT = join(homedir(), ".nexusclaw", "media");
export const INBOUND_DIRNAME    = "inbound";
export const OUTBOUND_DIRNAME   = "outbound";

/** Inline this many bytes directly into the agent message; spill past it. */
export const MEDIA_INLINE_SIZE_LIMIT = 2 * 1024 * 1024;

/** Files older than this get swept on the next save. */
export const MEDIA_TTL_MS = 2 * 60 * 1000;

/** URI scheme used in marker text passed to the agent. */
export const MEDIA_URI_PREFIX = "media://";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaBucket = "inbound" | "outbound";

export interface SavedMedia {
  /** Stable id: the {sanitized_original_name}---{uuid}.{ext} filename. */
  id:       string;
  /** Absolute path on disk. */
  path:     string;
  /** Bucket the file landed in. */
  bucket:   MediaBucket;
  /** Bytes on disk. */
  size:     number;
  /** Best-effort media type, derived from extension. */
  mimeType: string;
  /** The `media://inbound/<id>` URI a tool can resolve later. */
  uri:      string;
}

export interface MediaStorageOptions {
  /** Override the on-disk root. Defaults to `~/.nexusclaw/media`. */
  root?: string;
  /** Override TTL. Defaults to MEDIA_TTL_MS. */
  ttlMs?: number;
  /** Override clock — used in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const SAFE_NAME_CHARS = /[^A-Za-z0-9._-]+/g;
const MAX_NAME_LEN = 64;

/**
 * Reduce a platform-supplied filename to something filesystem-safe.
 * Empty or all-stripped names fall back to "media".
 */
export function sanitizeOriginalName(rawName: string | undefined): string {
  if (!rawName) return "media";
  // Drop the extension — we handle that separately so split/join is exact.
  const dot = rawName.lastIndexOf(".");
  const stem = dot > 0 ? rawName.slice(0, dot) : rawName;
  const cleaned = stem.replace(SAFE_NAME_CHARS, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) return "media";
  return cleaned.slice(0, MAX_NAME_LEN);
}

/** Lowercased extension (no leading dot) or "" when there isn't one. */
export function normalizeExtension(ext: string | undefined): string {
  if (!ext) return "";
  const trimmed = ext.replace(/^\./, "").toLowerCase().replace(SAFE_NAME_CHARS, "");
  return trimmed;
}

const MIME_BY_EXT: Record<string, string> = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  pdf:  "application/pdf",
  mp4:  "video/mp4",
  mov:  "video/quicktime",
  webm: "video/webm",
  mp3:  "audio/mpeg",
  m4a:  "audio/mp4",
  ogg:  "audio/ogg",
  oga:  "audio/ogg",
  wav:  "audio/wav",
};

export function mimeFromExtension(ext: string): string {
  return MIME_BY_EXT[normalizeExtension(ext)] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// MediaStorage
// ---------------------------------------------------------------------------

export class MediaStorage {
  private root: string;
  private ttlMs: number;
  private now: () => number;

  constructor(opts: MediaStorageOptions = {}) {
    this.root  = opts.root  ?? DEFAULT_MEDIA_ROOT;
    this.ttlMs = opts.ttlMs ?? MEDIA_TTL_MS;
    this.now   = opts.now   ?? (() => Date.now());
  }

  /** Bucket directory. Created on first use. */
  bucketDir(bucket: MediaBucket): string {
    return join(this.root, bucket === "inbound" ? INBOUND_DIRNAME : OUTBOUND_DIRNAME);
  }

  /**
   * Save raw bytes to the given bucket. The caller has already done any
   * decoding (e.g. base64 → bytes) — `data` is what hits disk verbatim.
   * Runs a TTL sweep over both buckets before writing.
   */
  save(
    bucket:        MediaBucket,
    originalName:  string | undefined,
    ext:           string | undefined,
    data:          Buffer,
  ): SavedMedia {
    this.sweepExpired();

    const dir = this.bucketDir(bucket);
    mkdirSync(dir, { recursive: true });

    const safeStem = sanitizeOriginalName(originalName);
    const normExt  = normalizeExtension(ext);
    const id       = normExt
      ? `${safeStem}---${randomUUID()}.${normExt}`
      : `${safeStem}---${randomUUID()}`;
    const path = join(dir, id);
    writeFileSync(path, data);

    return {
      id,
      path,
      bucket,
      size:     data.length,
      mimeType: mimeFromExtension(normExt),
      uri:      `${MEDIA_URI_PREFIX}${bucket}/${id}`,
    };
  }

  /**
   * Resolve a `media://inbound/<id>` URI to an absolute path. Returns null
   * for malformed URIs or files that do not exist. Does NOT escape the
   * media root — any id containing a path separator is rejected.
   */
  resolveUri(uri: string): string | null {
    if (!uri.startsWith(MEDIA_URI_PREFIX)) return null;
    const tail = uri.slice(MEDIA_URI_PREFIX.length);
    const slash = tail.indexOf("/");
    if (slash <= 0) return null;
    const bucketName = tail.slice(0, slash);
    const id         = tail.slice(slash + 1);
    if (bucketName !== "inbound" && bucketName !== "outbound") return null;
    if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
    const path = join(this.bucketDir(bucketName), id);
    try {
      statSync(path);
      return path;
    } catch {
      return null;
    }
  }

  /**
   * Delete files older than the TTL from both inbound and outbound. Safe
   * to call on every save — directories that don't exist are skipped. Best
   * effort: an individual unlink failure (e.g. concurrent removal) is
   * swallowed so the caller's save still proceeds.
   *
   * Returns the number of files that were removed (useful for tests).
   */
  sweepExpired(): number {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;
    for (const bucket of ["inbound", "outbound"] as const) {
      removed += this.sweepDir(this.bucketDir(bucket), cutoff);
    }
    return removed;
  }

  private sweepDir(dir: string, cutoff: number): number {
    let removed = 0;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0; // directory missing — nothing to do
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoff) {
          unlinkSync(full);
          removed += 1;
        }
      } catch {
        // best effort
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — most callers just want the default location.
// Tests construct their own MediaStorage with a tmpdir root.
// ---------------------------------------------------------------------------

let defaultStorage: MediaStorage | null = null;

export function getDefaultMediaStorage(): MediaStorage {
  if (!defaultStorage) defaultStorage = new MediaStorage();
  return defaultStorage;
}

/** Test helper — let suites swap in an isolated instance. */
export function setDefaultMediaStorage(s: MediaStorage | null): void {
  defaultStorage = s;
}

// ---------------------------------------------------------------------------
// Lightweight helpers used by callers that just need the extension.
// ---------------------------------------------------------------------------

/** Strip a path/filename down to the lowercase extension. */
export function extFromPath(path: string): string {
  return normalizeExtension(extname(path));
}
