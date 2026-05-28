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
}

/** A unique key derived from a RemoteIdentity (used as a Map key). */
export type RemoteIdentityKey = string;

export function identityKey(id: RemoteIdentity): RemoteIdentityKey {
  return `${id.platform}:${id.userId}:${id.chatId}`;
}

// ---------------------------------------------------------------------------
// Inbound — what an adapter delivers to the Gateway.
// ---------------------------------------------------------------------------

export type RemoteEvent =
  | {
      kind: "message";
      from: RemoteIdentity;
      text: string;
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
}

export interface OutboundInteractive {
  /** Heading shown above the buttons. */
  prompt: string;
  /** Choice buttons. The `value` is returned to the gateway on click. */
  options: ReadonlyArray<OutboundChoice>;
}

export interface OutboundChoice {
  label: string;
  value: string;
}

export interface ChannelData {
  telegram?: TelegramChannelData;
  // Future: slack?: SlackChannelData; discord?: DiscordChannelData; …
}

export interface TelegramChannelData {
  /** Text rendered above the bot's reply as a quoted excerpt. */
  quoteText?: string;
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
}
