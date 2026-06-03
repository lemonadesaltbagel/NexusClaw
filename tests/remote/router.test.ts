import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundRouter, getNormalizedMedia } from "@/remote/router";
import { MediaStorage } from "@/remote/media-storage";
import type {
  OutboundPayload,
  OutboundTarget,
  PlatformAdapter,
  RemoteEvent,
  RemoteIdentity,
  RemoteOutput,
  RemotePrompt,
  RemotePromptReply,
} from "@/remote/types";

class StubAdapter implements PlatformAdapter {
  readonly name: string;
  calls: Array<{ target: OutboundTarget; payload: OutboundPayload }> = [];
  constructor(name: string) { this.name = name; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onEvent(_h: (e: RemoteEvent) => void): void {}
  async send(_to: RemoteIdentity, _out: RemoteOutput): Promise<void> {}
  async prompt(_p: RemotePrompt): Promise<RemotePromptReply> {
    throw new Error("not used");
  }
  async sendPayload(target: OutboundTarget, payload: OutboundPayload): Promise<{ messageId?: number }> {
    this.calls.push({ target, payload });
    return { messageId: 100 + this.calls.length };
  }
  draftFor(): never {
    throw new Error("draftFor not used in router tests");
  }
}

describe("OutboundRouter", () => {
  test("dispatches to the adapter matching target.channel", async () => {
    const tg = new StubAdapter("telegram");
    const r = new OutboundRouter([tg]);
    const res = await r.send(
      { channel: "telegram", to: "42" },
      { text: "hi" },
    );
    expect(tg.calls).toHaveLength(1);
    expect(res.messageId).toBe(101);
  });

  test("throws on unknown channel", async () => {
    const r = new OutboundRouter([new StubAdapter("telegram")]);
    await expect(r.send({ channel: "slack", to: "C1" }, { text: "x" }))
      .rejects.toThrow(/no adapter registered/);
  });

  test("register() adds an adapter dynamically", async () => {
    const r = new OutboundRouter();
    const tg = new StubAdapter("telegram");
    r.register(tg);
    await r.send({ channel: "telegram", to: "1" }, { text: "x" });
    expect(tg.calls).toHaveLength(1);
  });

  test("channels() lists registered names", () => {
    const r = new OutboundRouter([new StubAdapter("telegram"), new StubAdapter("slack")]);
    expect(r.channels().sort()).toEqual(["slack", "telegram"]);
  });

  test("forwards both target and payload intact", async () => {
    const tg = new StubAdapter("telegram");
    const r = new OutboundRouter([tg]);
    const target: OutboundTarget = { channel: "telegram", to: "-100", threadId: "-100:topic:7" };
    const payload: OutboundPayload = {
      text: "Done! **x**",
      interactive: { blocks: [{ type: "buttons", buttons: [{ label: "Y", value: "y" }] }] },
      channelData: { telegram: { quoteText: "ctx" } },
    };
    await r.send(target, payload);
    expect(tg.calls[0]).toEqual({ target, payload });
  });

  describe("media normalization", () => {
    test("text-only payloads skip the normalizer (no normalized media attached)", async () => {
      const tg = new StubAdapter("telegram");
      const r = new OutboundRouter([tg]);
      await r.send({ channel: "telegram", to: "1" }, { text: "hi" });
      expect(getNormalizedMedia(tg.calls[0]!.payload)).toBeUndefined();
    });

    test("legacy mediaUrls become normalized URL entries the adapter can read", async () => {
      const tg = new StubAdapter("telegram");
      const r = new OutboundRouter([tg]);
      await r.send(
        { channel: "telegram", to: "1" },
        { text: "", mediaUrls: ["https://x/a.png", "https://x/b.png"] },
      );
      const m = getNormalizedMedia(tg.calls[0]!.payload);
      expect(m).toEqual([
        { kind: "url", url: "https://x/a.png", role: "auto", contentType: "image/png" },
        { kind: "url", url: "https://x/b.png", role: "auto", contentType: "image/png" },
      ]);
    });

    test("the new media field saves buffers and paths into media/outbound/", async () => {
      const root = mkdtempSync(join(tmpdir(), "nx-router-media-"));
      const storage = new MediaStorage({ root });
      const tg = new StubAdapter("telegram");
      const r = new OutboundRouter([tg], { mediaStorage: storage });

      const srcDir = mkdtempSync(join(tmpdir(), "nx-src-"));
      const src = join(srcDir, "thing.pdf");
      writeFileSync(src, Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF

      await r.send(
        { channel: "telegram", to: "1" },
        {
          text: "",
          media: [
            { kind: "url", url: "https://x/a.gif", role: "animation" },
            { kind: "buffer", data: Buffer.from("hi"), contentType: "image/png", fileName: "out.png" },
            { kind: "path", path: src, contentType: "application/pdf", role: "document" },
          ],
        },
      );

      const m = getNormalizedMedia(tg.calls[0]!.payload);
      expect(m).toHaveLength(3);
      expect(m![0]).toEqual({ kind: "url", url: "https://x/a.gif", role: "animation" });
      expect(m![1]).toMatchObject({ kind: "file", contentType: "image/png", role: "auto" });
      expect((m![1] as { path: string }).path).toContain("/outbound/");
      expect(m![2]).toMatchObject({ kind: "file", contentType: "application/pdf", role: "document" });
    });
  });
});
