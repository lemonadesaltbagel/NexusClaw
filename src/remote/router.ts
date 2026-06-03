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
import {
  normalizeOutboundMedia,
  type OutboundMedia,
  type OutboundMediaInput,
} from "@/remote/outbound-media";
import type { MediaStorage } from "@/remote/media-storage";

export interface OutboundRouterOptions {
  /** Override the on-disk media store used by the media normalizer. */
  mediaStorage?: MediaStorage;
}

/**
 * `PlatformAdapter.sendPayload` accepts the original `OutboundPayload`. The
 * router pre-normalizes media and stashes the resolved list under this hidden
 * extension key. Adapters that opt into the new pipeline read the array;
 * legacy code still sees `mediaUrl` / `mediaUrls` untouched. The marker is a
 * Symbol so it never collides with caller-set fields.
 */
export const NORMALIZED_MEDIA = Symbol.for("nexusclaw.normalizedMedia");

export interface NormalizedPayloadExtras {
  [NORMALIZED_MEDIA]?: ReadonlyArray<OutboundMedia>;
}

export class OutboundRouter {
  private byName = new Map<string, PlatformAdapter>();
  private mediaStorage: MediaStorage | undefined;

  constructor(
    adapters: ReadonlyArray<PlatformAdapter> = [],
    opts: OutboundRouterOptions = {},
  ) {
    for (const a of adapters) this.byName.set(a.name, a);
    this.mediaStorage = opts.mediaStorage;
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

    const inputs = this.collectMediaInputs(payload);
    if (inputs.length === 0) {
      return adapter.sendPayload(target, payload);
    }
    const normalized = normalizeOutboundMedia(inputs, {
      ...(this.mediaStorage ? { storage: this.mediaStorage } : {}),
    });
    const enriched: OutboundPayload & NormalizedPayloadExtras = {
      ...payload,
      [NORMALIZED_MEDIA]: normalized,
    };
    return adapter.sendPayload(target, enriched);
  }

  /** Names of all registered platforms. */
  channels(): string[] {
    return Array.from(this.byName.keys());
  }

  /**
   * Merge the legacy mediaUrl / mediaUrls / forceDocument fields with the
   * new `media` array into one input list. Legacy URL strings are passed
   * through as auto-classified strings; `forceDocument` is applied at the
   * adapter level (it was already a payload-wide flag and stays so).
   */
  private collectMediaInputs(p: OutboundPayload): OutboundMediaInput[] {
    const inputs: OutboundMediaInput[] = [];
    if (p.mediaUrls) for (const u of p.mediaUrls) inputs.push(u);
    if (p.mediaUrl)  inputs.push(p.mediaUrl);
    if (p.media)     for (const m of p.media) inputs.push(m);
    return inputs;
  }
}

/** Extract normalized media from a payload, if the router populated it. */
export function getNormalizedMedia(
  p: OutboundPayload,
): ReadonlyArray<OutboundMedia> | undefined {
  return (p as OutboundPayload & NormalizedPayloadExtras)[NORMALIZED_MEDIA];
}
