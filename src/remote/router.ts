// ---------------------------------------------------------------------------
// OutboundRouter — picks the right adapter for an outbound payload.
//
// Looks up the platform adapter by `target.channel` and forwards the
// payload to its `sendPayload` method. Adapter handles platform-specific
// denormalization (markdown→HTML, channelData mapping, threadId parsing).
// ---------------------------------------------------------------------------

import type {
  OutboundPayload,
  OutboundTarget,
  PlatformAdapter,
} from "@/remote/types";

export class OutboundRouter {
  private byName = new Map<string, PlatformAdapter>();

  constructor(adapters: ReadonlyArray<PlatformAdapter> = []) {
    for (const a of adapters) this.byName.set(a.name, a);
  }

  /** Register an adapter. Overwrites any previous adapter with the same name. */
  register(adapter: PlatformAdapter): void {
    this.byName.set(adapter.name, adapter);
  }

  /** Dispatch a payload to the adapter named by `target.channel`. */
  async send(
    target: OutboundTarget,
    payload: OutboundPayload,
  ): Promise<{ messageId?: number }> {
    const adapter = this.byName.get(target.channel);
    if (!adapter) {
      throw new Error(`OutboundRouter: no adapter registered for channel "${target.channel}"`);
    }
    return adapter.sendPayload(target, payload);
  }

  /** Names of all registered platforms. */
  channels(): string[] {
    return Array.from(this.byName.keys());
  }
}
