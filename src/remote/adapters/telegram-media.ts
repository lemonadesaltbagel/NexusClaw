// ---------------------------------------------------------------------------
// Telegram media ingest — pulls binary attachments off an inbound message
// and saves them through the shared MediaStorage. Pure-function shape so
// the adapter just decides "media or not" and delegates the rest here.
//
// Telegram delivers media as a `file_id`. The fetch is a two-hop dance:
//   1. bot.api.getFile(fileId) → { file_path }
//   2. GET https://api.telegram.org/file/bot<TOKEN>/<file_path>
// We do step 2 with the global `fetch` so tests can swap it out by
// passing a custom `download` function.
// ---------------------------------------------------------------------------

import type { Message } from "grammy/types";
import {
  MEDIA_INLINE_SIZE_LIMIT,
  type MediaStorage,
  type SavedMedia,
} from "@/remote/media-storage";

// ---------------------------------------------------------------------------
// Source detection — which message field holds the binary, and which file
// id should we pull. Telegram's `photo` field is a thumbnail ladder; we
// always pick the largest variant. Other media kinds expose one file_id.
// ---------------------------------------------------------------------------

export interface TelegramMediaSource {
  kind:      "photo" | "document" | "video" | "audio" | "voice" | "video_note" | "animation" | "sticker";
  fileId:    string;
  /** Best-effort original filename — only documents carry one. */
  fileName?: string;
  /** Best-effort mime type from Telegram. May be absent. */
  mimeType?: string;
  /** Telegram-reported size, in bytes, when available. Used as a pre-fetch hint only. */
  fileSize?: number;
}

/**
 * Inspect a grammY `Message` and return the media descriptor (if any).
 * Order matches Telegram's de-facto union order: documents that happen to
 * be photos are matched as documents.
 */
export function detectMedia(msg: Message): TelegramMediaSource | null {
  if (msg.document) {
    return {
      kind:     "document",
      fileId:   msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
      fileSize: msg.document.file_size,
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!;
    return { kind: "photo", fileId: largest.file_id, fileSize: largest.file_size };
  }
  if (msg.video) {
    return {
      kind:     "video",
      fileId:   msg.video.file_id,
      fileName: msg.video.file_name,
      mimeType: msg.video.mime_type,
      fileSize: msg.video.file_size,
    };
  }
  if (msg.audio) {
    return {
      kind:     "audio",
      fileId:   msg.audio.file_id,
      fileName: msg.audio.file_name,
      mimeType: msg.audio.mime_type,
      fileSize: msg.audio.file_size,
    };
  }
  if (msg.voice) {
    return {
      kind:     "voice",
      fileId:   msg.voice.file_id,
      mimeType: msg.voice.mime_type,
      fileSize: msg.voice.file_size,
    };
  }
  if (msg.video_note) {
    return { kind: "video_note", fileId: msg.video_note.file_id, fileSize: msg.video_note.file_size };
  }
  if (msg.animation) {
    return {
      kind:     "animation",
      fileId:   msg.animation.file_id,
      fileName: msg.animation.file_name,
      mimeType: msg.animation.mime_type,
      fileSize: msg.animation.file_size,
    };
  }
  if (msg.sticker) {
    return { kind: "sticker", fileId: msg.sticker.file_id, fileSize: msg.sticker.file_size };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension hints — for naming and for the analyze_image MIME guesser.
// Telegram's mime_type is reliable when present; photos lack one and need
// the file_path extension instead.
// ---------------------------------------------------------------------------

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg":            "jpg",
  "image/png":             "png",
  "image/gif":             "gif",
  "image/webp":            "webp",
  "image/heic":            "heic",
  "application/pdf":       "pdf",
  "video/mp4":             "mp4",
  "video/quicktime":       "mov",
  "video/webm":            "webm",
  "audio/mpeg":            "mp3",
  "audio/mp4":             "m4a",
  "audio/ogg":             "ogg",
  "audio/wav":             "wav",
  "audio/x-wav":           "wav",
};

export function extFromTelegram(
  filePath: string | undefined,
  mimeType: string | undefined,
): string {
  if (filePath) {
    const dot = filePath.lastIndexOf(".");
    if (dot > 0) return filePath.slice(dot + 1).toLowerCase();
  }
  if (mimeType && EXT_BY_MIME[mimeType]) return EXT_BY_MIME[mimeType]!;
  return "";
}

// ---------------------------------------------------------------------------
// Download — produces (bytes, file_path) so the caller can pick an
// extension. `download` is injectable for tests.
// ---------------------------------------------------------------------------

/** Minimal subset of grammY's `bot.api.getFile` we depend on. */
export interface GetFileFn {
  (fileId: string): Promise<{ file_path?: string; file_size?: number }>;
}

/** Pluggable HTTPS fetcher. Defaults to global `fetch`. */
export type Downloader = (url: string) => Promise<Buffer>;

const defaultDownloader: Downloader = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`telegram: file download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Resolve a file_id to (bytes, file_path) by calling Telegram's getFile and
 * fetching the resulting download URL. Errors surface to the caller so the
 * adapter can decide whether to drop or report.
 */
export async function fetchTelegramFile(
  token:    string,
  fileId:   string,
  getFile:  GetFileFn,
  download: Downloader = defaultDownloader,
): Promise<{ bytes: Buffer; filePath?: string }> {
  const file = await getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error(`telegram: getFile returned no file_path for ${fileId}`);
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const bytes = await download(url);
  return { bytes, filePath };
}

// ---------------------------------------------------------------------------
// Ingest — download + save + classify size. The adapter uses this once per
// media-bearing message; the returned `IngestedMedia` (from the shared
// inbound-media module) plus the inline-eligible flag drives the
// inline-vs-marker decision built by `buildInboundShape`.
// ---------------------------------------------------------------------------

import type { IngestedMedia } from "@/remote/inbound-media";

export interface IngestOptions {
  token:    string;
  storage:  MediaStorage;
  getFile:  GetFileFn;
  download?: Downloader;
  /** Override the inline threshold — tests use a small value. */
  inlineLimit?: number;
}

export async function ingestTelegramMedia(
  source: TelegramMediaSource,
  opts:   IngestOptions,
): Promise<IngestedMedia> {
  const { bytes, filePath } = await fetchTelegramFile(
    opts.token, source.fileId, opts.getFile, opts.download,
  );
  const ext = extFromTelegram(filePath, source.mimeType);
  const saved = opts.storage.save("inbound", source.fileName, ext, bytes);
  const limit = opts.inlineLimit ?? MEDIA_INLINE_SIZE_LIMIT;
  const inlineEligible = bytes.length <= limit;
  return {
    saved,
    inlineEligible,
    inlineBytes: inlineEligible ? bytes : null,
  };
}

// Re-export the shared shape + builder so the existing adapter imports
// keep working without churn.
export { buildInboundShape, type IngestedMedia, type InboundShape } from "@/remote/inbound-media";
