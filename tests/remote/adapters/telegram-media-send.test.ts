import { test, expect, describe } from "bun:test";
import { InputFile } from "grammy";
import {
  chooseTelegramMethod,
  buildTelegramInput,
  sendOneTelegramMedia,
  NO_CAPTION_METHODS,
  type TelegramApiSurface,
  type TelegramSendMethod,
} from "@/remote/adapters/telegram-media-send";
import type { OutboundMedia } from "@/remote/outbound-media";

// ---------------------------------------------------------------------------
// chooseTelegramMethod — the role/MIME picker
// ---------------------------------------------------------------------------

describe("chooseTelegramMethod", () => {
  test("forceDocument always wins", () => {
    expect(chooseTelegramMethod("image/png", "photo", true)).toBe("sendDocument");
    expect(chooseTelegramMethod("video/mp4", "video", true)).toBe("sendDocument");
  });

  test("explicit role maps directly", () => {
    expect(chooseTelegramMethod("image/png",  "photo",      false)).toBe("sendPhoto");
    expect(chooseTelegramMethod("image/gif",  "animation",  false)).toBe("sendAnimation");
    expect(chooseTelegramMethod("video/mp4",  "video",      false)).toBe("sendVideo");
    expect(chooseTelegramMethod("video/mp4",  "video_note", false)).toBe("sendVideoNote");
    expect(chooseTelegramMethod("audio/ogg",  "voice",      false)).toBe("sendVoice");
    expect(chooseTelegramMethod("audio/mpeg", "audio",      false)).toBe("sendAudio");
    expect(chooseTelegramMethod("image/webp", "sticker",    false)).toBe("sendSticker");
    expect(chooseTelegramMethod("any",        "document",   false)).toBe("sendDocument");
  });

  test("auto role uses contentType heuristic", () => {
    expect(chooseTelegramMethod("image/gif",  "auto", false)).toBe("sendAnimation");
    expect(chooseTelegramMethod("image/png",  "auto", false)).toBe("sendPhoto");
    expect(chooseTelegramMethod("image/jpeg", "auto", false)).toBe("sendPhoto");
    expect(chooseTelegramMethod("video/mp4",  "auto", false)).toBe("sendVideo");
    expect(chooseTelegramMethod("audio/mpeg", "auto", false)).toBe("sendAudio");
    expect(chooseTelegramMethod("audio/ogg",  "auto", false)).toBe("sendAudio"); // not voice — needs explicit role
    expect(chooseTelegramMethod(undefined,    "auto", false)).toBe("sendDocument");
    expect(chooseTelegramMethod("text/plain", "auto", false)).toBe("sendDocument");
  });
});

// ---------------------------------------------------------------------------
// buildTelegramInput
// ---------------------------------------------------------------------------

describe("buildTelegramInput", () => {
  test("url kind returns the URL string verbatim", () => {
    const m: OutboundMedia = { kind: "url", url: "https://x/a.png", role: "auto" };
    expect(buildTelegramInput(m)).toBe("https://x/a.png");
  });

  test("file kind wraps the path in an InputFile", () => {
    const m: OutboundMedia = {
      kind:        "file",
      path:        "/tmp/x.png",
      contentType: "image/png",
      fileName:    "x.png",
      role:        "auto",
    };
    const out = buildTelegramInput(m);
    expect(out).toBeInstanceOf(InputFile);
  });
});

// ---------------------------------------------------------------------------
// sendOneTelegramMedia — verifies dispatch into a fake api
// ---------------------------------------------------------------------------

function fakeApi(): TelegramApiSurface & { calls: Array<{ method: string; chatId: string; file: unknown; opts: Record<string, unknown> }> } {
  const calls: Array<{ method: string; chatId: string; file: unknown; opts: Record<string, unknown> }> = [];
  const make = (name: TelegramSendMethod) =>
    async (chatId: string, file: unknown, opts: Record<string, unknown>) => {
      calls.push({ method: name, chatId, file, opts });
      return { message_id: calls.length };
    };
  return {
    calls,
    sendPhoto:     make("sendPhoto"),
    sendAnimation: make("sendAnimation"),
    sendVideo:     make("sendVideo"),
    sendVideoNote: make("sendVideoNote"),
    sendVoice:     make("sendVoice"),
    sendAudio:     make("sendAudio"),
    sendDocument:  make("sendDocument"),
    sendSticker:   make("sendSticker"),
  } as TelegramApiSurface & { calls: Array<{ method: string; chatId: string; file: unknown; opts: Record<string, unknown> }> };
}

describe("sendOneTelegramMedia", () => {
  test("URL photo → sendPhoto with the URL string as the file arg", async () => {
    const api = fakeApi();
    const out = await sendOneTelegramMedia(
      api,
      "-100",
      { kind: "url", url: "https://x/a.jpg", role: "auto", contentType: "image/jpeg" },
      { caption: "hi" },
    );
    expect(out.method).toBe("sendPhoto");
    expect(api.calls[0]).toMatchObject({
      method: "sendPhoto",
      chatId: "-100",
      file:   "https://x/a.jpg",
      opts:   { caption: "hi", parse_mode: "HTML" },
    });
  });

  test("file animation (gif) → sendAnimation with an InputFile", async () => {
    const api = fakeApi();
    await sendOneTelegramMedia(
      api,
      "-100",
      { kind: "file", path: "/tmp/x.gif", contentType: "image/gif", role: "auto", fileName: "x.gif" },
    );
    expect(api.calls[0]!.method).toBe("sendAnimation");
    expect(api.calls[0]!.file).toBeInstanceOf(InputFile);
  });

  test("video_note role drops caption (api method doesn't accept it)", async () => {
    const api = fakeApi();
    await sendOneTelegramMedia(
      api,
      "-100",
      { kind: "file", path: "/tmp/x.mp4", contentType: "video/mp4", role: "video_note" },
      { caption: "ignored" },
    );
    expect(api.calls[0]!.method).toBe("sendVideoNote");
    expect(api.calls[0]!.opts.caption).toBeUndefined();
    expect(api.calls[0]!.opts.parse_mode).toBeUndefined();
  });

  test("forceDocument routes to sendDocument regardless of role", async () => {
    const api = fakeApi();
    await sendOneTelegramMedia(
      api,
      "-100",
      { kind: "url", url: "https://x/big.bin", role: "photo", contentType: "image/png" },
      { forceDocument: true, caption: "an upload" },
    );
    expect(api.calls[0]!.method).toBe("sendDocument");
    expect(api.calls[0]!.opts.caption).toBe("an upload");
  });

  test("extra opts are merged in (thread id, reply markup, etc.)", async () => {
    const api = fakeApi();
    await sendOneTelegramMedia(
      api,
      "-100",
      { kind: "url", url: "https://x/a.png", role: "photo" },
      { extraOpts: { message_thread_id: 7, reply_to_message_id: 42 } },
    );
    expect(api.calls[0]!.opts).toMatchObject({
      message_thread_id:   7,
      reply_to_message_id: 42,
    });
  });

  test("NO_CAPTION_METHODS is the authoritative set", () => {
    expect(NO_CAPTION_METHODS.has("sendVideoNote")).toBe(true);
    expect(NO_CAPTION_METHODS.has("sendSticker")).toBe(true);
    expect(NO_CAPTION_METHODS.has("sendPhoto")).toBe(false);
    expect(NO_CAPTION_METHODS.has("sendDocument")).toBe(false);
  });
});
