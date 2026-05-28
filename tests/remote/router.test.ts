import { test, expect, describe } from "bun:test";
import { OutboundRouter } from "@/remote/router";
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
      interactive: { prompt: "?", options: [{ label: "Y", value: "y" }] },
      channelData: { telegram: { quoteText: "ctx" } },
    };
    await r.send(target, payload);
    expect(tg.calls[0]).toEqual({ target, payload });
  });
});
