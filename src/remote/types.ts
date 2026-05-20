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
  | { kind: "message";   from: RemoteIdentity; text: string }
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
}
