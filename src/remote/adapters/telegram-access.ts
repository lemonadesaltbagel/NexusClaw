// ---------------------------------------------------------------------------
// Telegram access control — pure helpers for chat-space classification and
// group/forum policy enforcement.
//
// DM handling is intentionally out of scope for this stage; classifyChat
// still returns a "dm" kind so the adapter can branch, but checkGroupAccess
// does not enforce DM rules.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatSpace =
  | { kind: "dm" }
  | { kind: "group";   chatId: string }
  | { kind: "forum";   chatId: string; topicId: string }
  | { kind: "channel" };

export type GroupPolicyKind = "disabled" | "open" | "allowlist";

export interface GroupPolicy {
  policy: GroupPolicyKind;
  /** Used only when policy === "allowlist". Native userIds (as strings). */
  allowedUsers?: string[];
  /** Forum-only. topicId → { enabled }. Missing topic → denied. */
  topics?: Record<string, { enabled: boolean }>;
}

export interface AccessSettings {
  /** chatId → policy. Missing chat → denied. */
  groups?: Record<string, GroupPolicy>;
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

// ---------------------------------------------------------------------------
// classifyChat — map a raw Telegram chat + message shape to a ChatSpace.
// ---------------------------------------------------------------------------

interface ChatLike  { id: number | string; type: string }
interface MessageLike {
  is_topic_message?: boolean;
  message_thread_id?: number;
}

export function classifyChat(chat: ChatLike, message: MessageLike): ChatSpace {
  if (chat.type === "private") return { kind: "dm" };
  if (chat.type === "channel") return { kind: "channel" };
  // group | supergroup
  if (message.is_topic_message && message.message_thread_id !== undefined) {
    return {
      kind: "forum",
      chatId: String(chat.id),
      topicId: String(message.message_thread_id),
    };
  }
  return { kind: "group", chatId: String(chat.id) };
}

// ---------------------------------------------------------------------------
// isSelfMessage — true when the sender is the bot itself. Defensive: bots
// don't normally see their own messages echoed back, but multi-bot or
// forwarded scenarios can produce them. Drop them to avoid feedback loops.
// ---------------------------------------------------------------------------

export function isSelfMessage(fromId: number | undefined, botId: number): boolean {
  return fromId !== undefined && fromId === botId;
}

// ---------------------------------------------------------------------------
// checkGroupAccess — enforce per-chat (and per-topic) policy. DMs pass
// through unconditionally here; they're gated by the gateway's userMap.
// Channels are always denied (bots aren't designed for them in this build).
// ---------------------------------------------------------------------------

export function checkGroupAccess(
  space: ChatSpace,
  userId: string,
  settings: AccessSettings,
): AccessDecision {
  if (space.kind === "dm")      return { allowed: true };
  if (space.kind === "channel") return { allowed: false, reason: "channels not supported" };

  const group = settings.groups?.[space.chatId];
  if (!group)                       return { allowed: false, reason: "group not configured" };
  if (group.policy === "disabled")  return { allowed: false, reason: "group disabled" };

  if (space.kind === "forum") {
    const topic = group.topics?.[space.topicId];
    if (!topic)         return { allowed: false, reason: "topic not configured" };
    if (!topic.enabled) return { allowed: false, reason: "topic disabled" };
  }

  if (group.policy === "open") return { allowed: true };

  if (group.policy === "allowlist") {
    if (group.allowedUsers?.includes(userId)) return { allowed: true };
    return { allowed: false, reason: "user not in allowlist" };
  }

  return { allowed: false, reason: "unknown policy" };
}
