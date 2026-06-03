// ---------------------------------------------------------------------------
// Outbound media — the symmetric counterpart to the inbound media stream.
//
// The agent (or whoever emits an OutboundPayload) supplies one of three
// source shapes for each attachment:
//   • string          — auto-classified: http/https/data URLs pass through,
//                       anything else is treated as a local path.
//   • { kind:"url", … }    — explicit remote ref, no disk staging.
//   • { kind:"path", … }   — local file, copied into media/outbound/.
//   • { kind:"buffer", … } — raw bytes, written to media/outbound/.
//
// The normalizer reduces that union to a uniform `OutboundMedia` discriminated
// union with exactly two flavors: `url` (string) or `file` (on-disk path +
// contentType). The platform adapter consumes only the normalized shape and
// decides how to upload — Telegram wraps `file` paths in `InputFile` and
// chooses an API method per content type / role; Slack would multipart-upload
// the same bytes via files.upload; web would link to the served path.
//
// Why copy paths into media/outbound/ instead of uploading directly from the
// original location? Two reasons:
//   1. Same TTL-swept staging area as inbound — generated artifacts vanish
//      after the 2-minute window, no separate cleanup.
//   2. Adapters never read from arbitrary disk locations the agent supplied,
//      they only read from a known-safe directory.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  MediaStorage,
  extFromPath,
  getDefaultMediaStorage,
  mimeFromExtension,
} from "@/remote/media-storage";

// ---------------------------------------------------------------------------
// Roles — a hint from the agent for "what kind of media is this, semantically".
// Platforms with multiple native surfaces (Telegram's photo/animation/video/
// voice/video_note/audio/document/sticker) honor the role to pick the right
// API. Single-surface platforms (Slack file upload, Discord attachment) treat
// every role the same.
// ---------------------------------------------------------------------------

export type OutboundMediaRole =
  | "auto"        // pick by content type
  | "photo"
  | "animation"   // GIF / silent video
  | "video"
  | "video_note"  // Telegram circular video note
  | "audio"
  | "voice"       // OGG/Opus voice — Telegram sendVoice
  | "document"
  | "sticker";

// ---------------------------------------------------------------------------
// Input shapes — what callers hand to the router. Plain strings stay
// supported as a convenience so existing callers that pass `mediaUrls:
// ["https://…"]` keep working unchanged.
// ---------------------------------------------------------------------------

export type OutboundMediaInput =
  | string
  | {
      kind:        "url";
      url:         string;
      contentType?: string;
      fileName?:    string;
      role?:        OutboundMediaRole;
    }
  | {
      kind:        "path";
      path:        string;
      contentType?: string;
      fileName?:    string;
      role?:        OutboundMediaRole;
    }
  | {
      kind:        "buffer";
      data:        Buffer;
      contentType: string;
      fileName?:   string;
      role?:       OutboundMediaRole;
    };

// ---------------------------------------------------------------------------
// Output shape — what the adapter sees. Always one of two flavors so the
// adapter's dispatcher is a flat switch on `m.kind`.
// ---------------------------------------------------------------------------

export type OutboundMedia =
  | {
      kind:         "url";
      url:          string;
      contentType?: string;
      fileName?:    string;
      role:         OutboundMediaRole;
    }
  | {
      kind:        "file";
      path:        string;
      contentType: string;
      fileName?:   string;
      role:        OutboundMediaRole;
    };

// ---------------------------------------------------------------------------
// Heuristics — auto-classify a bare string and infer extensions/types when
// the caller didn't supply them. Kept small and explicit; platform plugins
// extend their own MIME maps as needed.
// ---------------------------------------------------------------------------

const URL_SCHEME = /^(https?|data):/i;

export function looksLikeUrl(s: string): boolean {
  return URL_SCHEME.test(s);
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg":      "jpg",
  "image/png":       "png",
  "image/gif":       "gif",
  "image/webp":      "webp",
  "video/mp4":       "mp4",
  "video/quicktime": "mov",
  "video/webm":      "webm",
  "audio/mpeg":      "mp3",
  "audio/mp4":       "m4a",
  "audio/ogg":       "ogg",
  "audio/wav":       "wav",
  "application/pdf": "pdf",
};

export function extFromContentType(ct: string | undefined): string {
  if (!ct) return "";
  return EXT_BY_MIME[ct.toLowerCase()] ?? "";
}

/**
 * Best-effort content-type inference for a URL string. We look only at the
 * trailing extension of the URL path — query strings and fragments are
 * stripped first. Returns undefined when the extension isn't one we know,
 * so callers can decide whether to leave the type absent.
 */
export function contentTypeFromUrl(url: string): string | undefined {
  const noQuery = url.split(/[?#]/)[0] ?? url;
  const dot = noQuery.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = noQuery.slice(dot + 1).toLowerCase();
  const ct = mimeFromExtension(ext);
  return ct === "application/octet-stream" ? undefined : ct;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export interface NormalizeOptions {
  /** Override the on-disk media store. Defaults to the singleton. */
  storage?: MediaStorage;
}

/**
 * Reduce an arbitrary list of `OutboundMediaInput` values into the uniform
 * `OutboundMedia` shape the adapters consume. Paths and buffers land in
 * `media/outbound/`; URLs pass through. The storage layer's TTL sweep runs
 * on every write so stale generated artifacts get cleaned up automatically.
 */
export function normalizeOutboundMedia(
  inputs: ReadonlyArray<OutboundMediaInput>,
  opts:   NormalizeOptions = {},
): OutboundMedia[] {
  const storage = opts.storage ?? getDefaultMediaStorage();
  const out: OutboundMedia[] = [];

  for (const it of inputs) {
    // Bare string — classify by scheme. URLs short-circuit; everything else
    // is treated as a local path read off disk. URL bare strings get a
    // sniffed contentType when the extension is recognizable so the platform
    // method picker can route to the right surface (sendPhoto vs sendDocument).
    if (typeof it === "string") {
      if (looksLikeUrl(it)) {
        const ct = contentTypeFromUrl(it);
        out.push({
          kind: "url",
          url:  it,
          role: "auto",
          ...(ct ? { contentType: ct } : {}),
        });
      } else {
        out.push(saveLocalPath(storage, it, undefined, undefined, "auto"));
      }
      continue;
    }

    switch (it.kind) {
      case "url":
        out.push({
          kind: "url",
          url:  it.url,
          role: it.role ?? "auto",
          ...(it.contentType ? { contentType: it.contentType } : {}),
          ...(it.fileName    ? { fileName:    it.fileName    } : {}),
        });
        break;

      case "path":
        out.push(saveLocalPath(storage, it.path, it.contentType, it.fileName, it.role ?? "auto"));
        break;

      case "buffer": {
        const ext      = extFromContentType(it.contentType);
        const original = it.fileName ?? "output";
        const saved    = storage.save("outbound", original, ext, it.data);
        out.push({
          kind:        "file",
          path:        saved.path,
          contentType: it.contentType,
          fileName:    it.fileName ?? saved.id,
          role:        it.role ?? "auto",
        });
        break;
      }
    }
  }

  return out;
}

// Local helper: read a path off disk and re-save under MediaStorage. The
// content-type is inferred from extension when the caller didn't supply one.
function saveLocalPath(
  storage:     MediaStorage,
  path:        string,
  contentType: string | undefined,
  fileName:    string | undefined,
  role:        OutboundMediaRole,
): OutboundMedia {
  const bytes = readFileSync(path);
  const base  = fileName ?? basename(path);
  const ext   = extFromPath(path);
  const saved = storage.save("outbound", base, ext, bytes);
  const ct    = contentType ?? mimeFromExtension(ext);
  return {
    kind:        "file",
    path:        saved.path,
    contentType: ct,
    fileName:    base,
    role,
  };
}
