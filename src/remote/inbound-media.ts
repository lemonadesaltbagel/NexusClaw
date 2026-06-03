// ---------------------------------------------------------------------------
// Inbound media — the cross-platform half of the ingest pipeline.
//
// Each adapter has its own platform-specific ingest function that knows how
// to pull binary attachments off whatever the platform delivers
// (Telegram's file_id + Bot API; Slack's file_url + token; Discord's CDN
// link; web's multipart form). Those functions converge on the same
// `IngestedMedia` shape defined here; from there the cross-platform
// `buildInboundShape` decides what goes inline vs. what gets a
// `media://` marker.
//
// The agent core never sees this module — it only sees the final
// `RemoteEvent.message.content` or `text`. Everything in this file is for
// adapters to share.
// ---------------------------------------------------------------------------

import type { SavedMedia } from "@/remote/media-storage";
import type { InboundContent } from "@/remote/types";

/**
 * The product of a per-platform ingest function: a saved file on disk plus
 * the bookkeeping needed to decide whether to embed it inline. Adapters
 * fill this in and hand it to `buildInboundShape`.
 */
export interface IngestedMedia {
  saved:           SavedMedia;
  /** True when the file is small enough to embed directly in the agent message. */
  inlineEligible:  boolean;
  /** Raw bytes — only kept when inlineEligible is true; null otherwise to save heap. */
  inlineBytes:     Buffer | null;
}

/**
 * Final inbound content the gateway forwards to the agent. `text` is always
 * the literal string (may include marker lines); `content` is the rich
 * block array, populated only when at least one item is being inlined.
 */
export interface InboundShape {
  text:    string;
  content: ReadonlyArray<InboundContent>;
}

/**
 * Compose the final inbound content from raw user text plus zero-or-more
 * ingested attachments. The decision tree:
 *
 *   • inline-eligible image → an `image` content block alongside text.
 *   • everything else (oversize, audio, video, document) → a marker line
 *     `[media attached: media://inbound/<id>]` appended to the text. The
 *     agent uses the appropriate tool to fetch the bytes later.
 *   • text-only inbound → plain text with an empty content array.
 *
 * Returned `text` is always the marker-suffixed string (useful as a log /
 * fallback); `content` is what the gateway passes to `agent.chat` when
 * non-empty.
 *
 * Pure transform — no I/O, no platform refs. Identical behavior for
 * Telegram, Slack, Discord, web, etc.
 */
export function buildInboundShape(
  userText:  string,
  media:     ReadonlyArray<IngestedMedia>,
): InboundShape {
  const markers: string[] = [];
  const blocks:  InboundContent[] = [];

  for (const m of media) {
    const canInline = m.inlineEligible
      && m.inlineBytes !== null
      && m.saved.mimeType.startsWith("image/");
    if (canInline) {
      blocks.push({
        type:     "image",
        data:     m.inlineBytes!.toString("base64"),
        mimeType: m.saved.mimeType,
      });
    } else {
      markers.push(`[media attached: ${m.saved.uri}]`);
    }
  }

  const trimmed   = userText.trim();
  const markerStr = markers.join("\n");
  const finalText = trimmed && markerStr
    ? `${trimmed}\n${markerStr}`
    : trimmed || markerStr;

  // When there are inline image blocks, the text block goes first so the
  // model reads context before looking at the picture.
  if (blocks.length > 0) {
    const out: InboundContent[] = [];
    if (finalText) out.push({ type: "text", text: finalText });
    for (const b of blocks) out.push(b);
    return { text: finalText, content: out };
  }
  return { text: finalText, content: [] };
}
