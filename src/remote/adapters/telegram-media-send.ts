// ---------------------------------------------------------------------------
// Telegram outbound media — picks the right Bot API method per content type
// + role and wraps file-kind media in grammY's `InputFile` so the upload
// goes out as multipart/form-data with the raw bytes in the file part.
//
// The agent emits a platform-neutral `OutboundMedia`. This module is the
// Telegram-specific denormalizer: same shape in, native API call out.
// ---------------------------------------------------------------------------

import { InputFile } from "grammy";
import type { OutboundMedia, OutboundMediaRole } from "@/remote/outbound-media";

/**
 * The Bot API method names we dispatch to. Each takes `(chatId, file, opts)`
 * where `file` is either an `InputFile` (multipart upload) or a string URL /
 * file_id. The options bag varies per method but the fields we set
 * (caption, parse_mode, reply_*, message_thread_id, reply_markup,
 * disable_notification) are uniformly supported by every method below.
 */
export type TelegramSendMethod =
  | "sendPhoto"
  | "sendAnimation"
  | "sendVideo"
  | "sendVideoNote"
  | "sendVoice"
  | "sendAudio"
  | "sendDocument"
  | "sendSticker";

/** Methods whose options bag does NOT accept `caption`. The caller drops captions for these. */
export const NO_CAPTION_METHODS: ReadonlySet<TelegramSendMethod> = new Set<TelegramSendMethod>([
  "sendVideoNote",
  "sendSticker",
]);

// ---------------------------------------------------------------------------
// Method picker — pure function so it's trivially testable.
//
// Priority order:
//   1. forceDocument → sendDocument
//   2. Explicit role wins.
//   3. Content type heuristic.
//   4. Fallback → sendDocument.
// ---------------------------------------------------------------------------

export function chooseTelegramMethod(
  contentType:   string | undefined,
  role:          OutboundMediaRole,
  forceDocument: boolean,
): TelegramSendMethod {
  if (forceDocument) return "sendDocument";

  switch (role) {
    case "photo":      return "sendPhoto";
    case "animation":  return "sendAnimation";
    case "video":      return "sendVideo";
    case "video_note": return "sendVideoNote";
    case "voice":      return "sendVoice";
    case "audio":      return "sendAudio";
    case "sticker":    return "sendSticker";
    case "document":   return "sendDocument";
    case "auto":
    default:
      return chooseByContentType(contentType);
  }
}

function chooseByContentType(ct: string | undefined): TelegramSendMethod {
  if (!ct) return "sendDocument";
  const lower = ct.toLowerCase();
  if (lower === "image/gif")          return "sendAnimation";
  if (lower.startsWith("image/"))     return "sendPhoto";
  if (lower.startsWith("video/"))     return "sendVideo";
  // We deliberately do NOT auto-classify audio/ogg as voice — voice is a
  // distinct UX (waveform render, push-to-talk) and the agent has to ask
  // for it explicitly via role: "voice".
  if (lower.startsWith("audio/"))     return "sendAudio";
  return "sendDocument";
}

// ---------------------------------------------------------------------------
// Input builder — file → InputFile, url → string.
//
// grammY's `InputFile(buffer | path | stream, filename)` wraps the data as
// a multipart field. Passing a string path lets grammY stream it off disk
// without slurping the whole file into memory.
// ---------------------------------------------------------------------------

export function buildTelegramInput(m: OutboundMedia): InputFile | string {
  if (m.kind === "url") return m.url;
  return new InputFile(m.path, m.fileName);
}

// ---------------------------------------------------------------------------
// Dispatcher — calls the right Bot API method with the right input. Tests
// stub a fake api to assert the dispatch shape.
// ---------------------------------------------------------------------------

/** Minimal grammY-shaped surface used by `sendOneTelegramMedia`. */
export interface TelegramApiSurface {
  sendPhoto:     (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
  sendAnimation: (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
  sendVideo:     (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
  sendVideoNote: (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
  sendVoice:     (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
  sendAudio:     (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
  sendDocument:  (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
  sendSticker:   (chatId: string, file: InputFile | string, opts: object) => Promise<{ message_id: number }>;
}

export interface SendOneOptions {
  forceDocument?: boolean;
  /** When the method supports `caption`, this gets attached. */
  caption?:       string;
  /** Other API-method options merged in verbatim (thread id, reply markup, etc.). */
  extraOpts?:     Record<string, unknown>;
}

export async function sendOneTelegramMedia(
  api:    TelegramApiSurface,
  chatId: string,
  media:  OutboundMedia,
  opts:   SendOneOptions = {},
): Promise<{ messageId: number; method: TelegramSendMethod }> {
  const method = chooseTelegramMethod(
    media.contentType,
    media.role,
    opts.forceDocument ?? false,
  );
  const file = buildTelegramInput(media);

  const apiOpts: Record<string, unknown> = { ...(opts.extraOpts ?? {}) };
  if (opts.caption && !NO_CAPTION_METHODS.has(method)) {
    apiOpts.caption    = opts.caption;
    apiOpts.parse_mode = "HTML";
  }

  // Per-method dispatch. The type assertions are local to this switch —
  // every method has the same `(chatId, file, opts)` signature, the picker
  // upstream guarantees the input fits.
  const result = await api[method](chatId, file, apiOpts);
  return { messageId: result.message_id, method };
}
