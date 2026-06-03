// ---------------------------------------------------------------------------
// Normalized vocabulary for the remote-control layer.
//
// Adapters speak their platform's native protocol on one side and these
// types on the other. The Gateway only ever sees these types — that is
// what makes the system transport-agnostic.
// ---------------------------------------------------------------------------

/** Where a remote message originated. Stable across one platform's API. */
export interface RemoteIdentity {
  /** Adapter name, e.g. "telegram", "slack", "discord", "web". */
  platform: string;
  /** Native user id as the platform exposes it (string for uniformity). */
  userId: string;
  /** Native chat/channel/conversation id — used for replies and rate scope. */
  chatId: string;
  /**
   * Sub-channel within `chatId`. Telegram forum topic id, Slack thread ts,
   * etc. Used by the originating adapter to route replies back into the
   * exact thread. NOT part of identityKey: messages from the same user
   * across multiple topics should still serialize through one per-user
   * lane in the gateway.
   */
  topicId?: string;
  /**
   * Native id of the inbound message this identity was captured from.
   * Carried alongside chat/thread/account so outbound replies can quote
   * or thread to the originating message without re-plumbing it.
   */
  messageId?: number;
}

/** A unique key derived from a RemoteIdentity (used as a Map key). */
export type RemoteIdentityKey = string;

export function identityKey(id: RemoteIdentity): RemoteIdentityKey {
  return `${id.platform}:${id.userId}:${id.chatId}`;
}

// ---------------------------------------------------------------------------
// Inbound — what an adapter delivers to the Gateway.
// ---------------------------------------------------------------------------

/**
 * One block of inbound content the agent receives. `text` is the user's
 * literal message (possibly suffixed with a `[media attached: …]` marker
 * for large attachments). `image` is an inline image block — only used
 * when the source media is small enough to embed directly.
 */
export type InboundContent =
  | { type: "text";  text: string }
  | { type: "image"; data: string; mimeType: string };

export type RemoteEvent =
  | {
      kind: "message";
      from: RemoteIdentity;
      /**
       * The user's plain-text message. Always present; for media-only
       * inbound messages this is "" (empty string), optionally appended
       * with a media marker line by the adapter.
       */
      text: string;
      /**
       * Full inbound content blocks when the adapter wants to pass media
       * inline (typically when each attachment is below the inline-size
       * threshold). When set, the gateway forwards this *instead* of
       * `text` to `agent.chat`. Adapters that only attach a marker leave
       * this undefined and let `text` carry the full message.
       */
      content?: ReadonlyArray<InboundContent>;
      /**
       * Optional per-turn abort signal. When set, the gateway forwards it
       * to `agent.chat`. The adapter sets this when it owns a per-turn
       * AbortController (e.g. Telegram's FloodGuard janitor).
       */
      signal?: AbortSignal;
    }
  | { kind: "command";   from: RemoteIdentity; name: string; args: string }
  | { kind: "interrupt"; from: RemoteIdentity }
  | { kind: "callback";  from: RemoteIdentity; id: string; value: string };

// ---------------------------------------------------------------------------
// Outbound — what the Gateway hands back to the originating adapter.
//
// Shaped to mirror the Agent's existing callback surface so wiring is
// mechanical: onText → text, onToolCall → tool_call, onToolResult →
// tool_result.
// ---------------------------------------------------------------------------

export type RemoteOutput =
  | { kind: "text";        delta: string }
  | { kind: "tool_call";   name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; name: string; result: string; ok: boolean }
  | { kind: "system";      level: "info" | "warn" | "error"; text: string }
  | { kind: "turn_done";   cost?: number };

// ---------------------------------------------------------------------------
// Outbound payload — platform-neutral shape for one outbound message.
//
// Telegram-shaped richness (quote-reply text, etc.) lives under
// `channelData.telegram`. Markdown→platform-native conversion is the
// adapter's job, not the payload's. Streaming text grows the same payload
// over time; the adapter edits the platform message in place and manages
// the messageId out-of-band, so the payload itself carries no messageId.
// ---------------------------------------------------------------------------

/** Where an outbound message should land. */
export interface OutboundTarget {
  /** Platform name, e.g. "telegram", "slack". */
  channel: string;
  /** Native chat / channel / DM id. */
  to: string;
  /**
   * Optional sub-thread within `to`. Free-form per platform; e.g. Telegram
   * forum topics encode `"<chatId>:topic:<topicId>"`.
   */
  threadId?: string;
  /**
   * Native id of the message to reply to. Combined with optional
   * `channelData.<channel>.quoteText` to render a proper quoted reply.
   * Captured by adapters from the inbound message and threaded through
   * so the agent doesn't need to know about message ids.
   */
  replyToId?: number;
}

/** Body of one outbound message — platform-neutral. */
export interface OutboundPayload {
  /**
   * Message text. For chat platforms this is markdown; each adapter is
   * responsible for converting it to the platform-native wire format.
   */
  text: string;
  /** Optional inline prompt with response buttons. */
  interactive?: OutboundInteractive;
  /** Per-channel escape hatch for fields that don't generalize. */
  channelData?: ChannelData;
  /**
   * Single attachment source — convenience for the common one-media case.
   * Normalized into `mediaUrls` by the shared helper before the adapter
   * sees it. Legacy: prefer `media` below.
   */
  mediaUrl?: string;
  /** Multiple attachment URL sources, in display order. Legacy: prefer `media`. */
  mediaUrls?: ReadonlyArray<string>;
  /**
   * Generic media attachments. Each entry can be a URL, a local path, a
   * buffer, or a bare string (auto-classified). The router normalizes them
   * into a uniform shape before handing off to the adapter, so platform
   * plugins only deal with `{ kind: "url" }` or `{ kind: "file" }`.
   *
   * See `OutboundMediaInput` in `@/remote/outbound-media`.
   */
  media?: ReadonlyArray<import("@/remote/outbound-media").OutboundMediaInput>;
  /**
   * Force images to be sent as documents (uncompressed). Affects how
   * adapters route to sendPhoto vs sendDocument; ignored by platforms
   * without that distinction.
   */
  forceDocument?: boolean;
  /**
   * Send without notification sound (and without push for some platforms).
   * Maps to `disable_notification` on Telegram.
   */
  silent?: boolean;
}

/**
 * Cross-channel interactive reply. A small ordered list of blocks: text,
 * buttons, select. Each adapter renders this into its native UI. For richer
 * platform-specific layouts (e.g. Telegram's full 2-D inline_keyboard with
 * arbitrary callback data), use `channelData.<channel>` on the payload.
 */
export interface OutboundInteractive {
  blocks: ReadonlyArray<InteractiveBlock>;
}

export type InteractiveBlock =
  | { type: "text";    text: string }
  | { type: "buttons"; buttons: ReadonlyArray<InteractiveButton> }
  | {
      type: "select";
      placeholder?: string;
      options: ReadonlyArray<InteractiveButton>;
    };

export interface InteractiveButton {
  label: string;
  value: string;
  /** Visual emphasis hint. Platforms without colored buttons may ignore. */
  style?: "primary" | "secondary" | "success" | "danger";
}

export interface ChannelData {
  telegram?: TelegramChannelData;
  // Future: slack?: SlackChannelData; discord?: DiscordChannelData; …
}

export interface TelegramChannelData {
  /** Text rendered above the bot's reply as a quoted excerpt. */
  quoteText?: string;
  /**
   * Telegram-specific inline keyboard override. When present, takes
   * priority over the generic `interactive` blocks. Free-form 2-D array
   * matching grammY's `InlineKeyboardButton[][]`; the adapter sends it
   * through unchanged.
   */
  inlineKeyboard?: ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;
}

/**
 * Subset of grammY's `InlineKeyboardButton`. Captures the common shapes
 * (callback, url, web app) without coupling to grammY's exact types.
 */
export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// DraftStream — owns the live "preview" bubble for one target. The agent
// never sees this object; the Coordinator drives it. The adapter remembers
// the current preview message id internally — callers don't pass it.
//
// Verbs:
//   update(delta)      — extend the preview text
//   flush()            — commit current text to the bubble now
//   materialize()      — finalize the draft as a permanent message
//   forceNewMessage()  — next update opens a fresh bubble
//   clear() / stop()   — drop in-flight tracking (does not delete the message)
// ---------------------------------------------------------------------------

export interface DraftStream {
  update(delta: string): void;
  flush(): Promise<void>;
  materialize(): Promise<void>;
  forceNewMessage(): void;
  clear(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Interactive prompts — confirmDangerous / planApproval bridged to the
// platform. Adapters render these with whatever UI the platform offers
// (Telegram inline buttons, Slack action blocks, web modal, etc.).
// ---------------------------------------------------------------------------

export type RemotePrompt =
  | { kind: "confirm"; to: RemoteIdentity; message: string }
  | {
      kind: "plan_approval";
      to: RemoteIdentity;
      planContent: string;
      choices: ReadonlyArray<{ id: string; label: string }>;
    };

export type RemotePromptReply =
  | { kind: "confirm"; allowed: boolean }
  | { kind: "plan_approval"; choiceId: string; feedback?: string };

// ---------------------------------------------------------------------------
// PlatformAdapter — every platform implements this. Adding a new platform
// = one new module under src/remote/adapters/ that satisfies this contract.
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  /** Stable adapter name, used in RemoteIdentity.platform and settings keys. */
  readonly name: string;

  /** Open the connection (long-poll, websocket, webhook listener, …). */
  start(): Promise<void>;

  /** Tear down gracefully. */
  stop(): Promise<void>;

  /** Subscribe to inbound events. Called once by the Gateway at startup. */
  onEvent(handler: (e: RemoteEvent) => void): void;

  /** Push a normalized output back to the user. Adapter handles rendering. */
  send(target: RemoteIdentity, out: RemoteOutput): Promise<void>;

  /** Ask the user something and wait for their reply. */
  prompt(p: RemotePrompt): Promise<RemotePromptReply>;

  /**
   * Send a platform-neutral payload. The adapter converts the markdown
   * `text` to its native format, denormalizes `channelData` into wire-level
   * fields, and dispatches one message to the platform.
   *
   * Returns the platform's message id when one is produced, or undefined
   * when not applicable. The caller (router) can hold this id to support
   * later edits / streaming.
   */
  sendPayload(target: OutboundTarget, payload: OutboundPayload): Promise<{ messageId?: number }>;

  /**
   * Return the per-target draft stream. The adapter caches one per
   * (chatId, threadId) so the same bubble is reused across updates.
   */
  draftFor(target: OutboundTarget): DraftStream;
}
