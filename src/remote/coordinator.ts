// ---------------------------------------------------------------------------
// Coordinator — receives agent callbacks (text deltas, tool calls/results,
// system notices, turn_done) and routes them through two pipelines:
//
//   * Preview pipeline — live `DraftStream` bubble that the user sees
//     grow delta by delta. Owned by the adapter; the coordinator just
//     calls `update / flush / materialize / forceNewMessage / clear`.
//
//   * Delivery pipeline — durable messages sent via the adapter's
//     `sendPayload`. Used for tool announcements, tool results, system
//     notices, and any explicit final message.
//
// The agent doesn't know about streams. It just emits events and the
// coordinator decides whether to extend the current preview, materialize
// it, or open a fresh delivery message.
// ---------------------------------------------------------------------------

import type {
  ChannelData,
  DraftStream,
  OutboundPayload,
  OutboundTarget,
  PlatformAdapter,
} from "@/remote/types";

export interface CoordinatorOptions {
  /** Whether agent text streams as a live preview (true) or is buffered until turn_done (false). */
  partial?: boolean;
  /** Adapter-specific channelData applied to delivery payloads. */
  channelData?: ChannelData;
}

export class Coordinator {
  private draft: DraftStream;
  private partial: boolean;
  private channelData: ChannelData | undefined;
  private buffer = "";

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly target: OutboundTarget,
    opts: CoordinatorOptions = {},
  ) {
    this.draft = adapter.draftFor(target);
    this.partial = opts.partial ?? true;
    this.channelData = opts.channelData;
  }

  /** Agent emitted a text delta. */
  text(delta: string): void {
    if (!delta) return;
    if (this.partial) {
      this.draft.update(delta);
    } else {
      this.buffer += delta;
    }
  }

  /**
   * Agent invoked a tool. Materialize the current preview (so subsequent
   * text starts in a fresh bubble) and send a separate durable message
   * announcing the tool call.
   */
  async toolCall(name: string, input: Record<string, unknown>): Promise<void> {
    await this.draft.materialize();
    await this.adapter.sendPayload(this.target, this.payload(
      `🔧 ${name}(${this.compactInput(input)})`,
    ));
  }

  /** Agent received a tool result. */
  async toolResult(name: string, result: string, ok: boolean): Promise<void> {
    await this.draft.materialize();
    const icon = ok ? "✓" : "✗";
    await this.adapter.sendPayload(this.target, this.payload(
      `${icon} ${name}\n${result}`,
    ));
  }

  /** System-level notice — info/warn/error. */
  async system(level: "info" | "warn" | "error", text: string): Promise<void> {
    await this.draft.materialize();
    const icon = level === "error" ? "⚠️" : level === "warn" ? "⚠" : "ℹ";
    await this.adapter.sendPayload(this.target, this.payload(`${icon} ${text}`));
  }

  /** Turn finished — materialize the preview into a permanent message. */
  async turnDone(): Promise<void> {
    if (!this.partial && this.buffer.length > 0) {
      // Buffered mode: send the accumulated text once as a delivery payload.
      const text = this.buffer;
      this.buffer = "";
      await this.adapter.sendPayload(this.target, this.payload(text));
    } else {
      await this.draft.materialize();
    }
  }

  /** Discard the current preview without finalizing. */
  async clear(): Promise<void> {
    await this.draft.clear();
    this.buffer = "";
  }

  // -------------------------------------------------------------------------

  private payload(text: string): OutboundPayload {
    const p: OutboundPayload = { text };
    if (this.channelData) p.channelData = this.channelData;
    return p;
  }

  private compactInput(input: Record<string, unknown>): string {
    try {
      const s = JSON.stringify(input);
      return s.length > 200 ? s.slice(0, 200) + "…" : s;
    } catch {
      return "{…}";
    }
  }
}
