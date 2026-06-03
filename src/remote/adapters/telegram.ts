// ---------------------------------------------------------------------------
// TelegramAdapter — first concrete PlatformAdapter.
//
// Inbound:  grammY long-poll → normalized RemoteEvent.
// Outbound: RemoteOutput → Bot API. Streamed text is edited-in-place on a
//           single in-flight message per turn, throttled to one edit per
//           500 ms so we stay under Telegram's per-chat rate limit.
// Prompts:  inline-keyboard buttons; the callback_query carries the prompt
//           id + choice id and resolves the pending promise.
// ---------------------------------------------------------------------------

import { Bot, InlineKeyboard } from "grammy";
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
import {
  markdownToTelegramHtml,
  chunkHtmlMessage,
  type OutboundChunk,
} from "@/remote/adapters/telegram-html";
import { Sequentializer } from "@/remote/sequentializer";
import { verboseLogUpdate } from "@/remote/adapters/telegram-verbose";
import {
  classifyChat,
  isSelfMessage,
  checkGroupAccess,
  type AccessSettings,
} from "@/remote/adapters/telegram-access";
import {
  checkDmAccess,
  formatPairingPrompt,
  type DmPolicyKind,
} from "@/remote/adapters/telegram-dm";
import {
  FloodGuard,
  type FloodLimits,
  type SyntheticMessage,
} from "@/remote/adapters/telegram-flood";
import {
  buildInboundShape,
  detectMedia,
  ingestTelegramMedia,
  type IngestedMedia,
  type TelegramMediaSource,
} from "@/remote/adapters/telegram-media";
import {
  getDefaultMediaStorage,
  type MediaStorage,
} from "@/remote/media-storage";

// ---------------------------------------------------------------------------
// Limits + tunables
// ---------------------------------------------------------------------------

export const MIN_EDIT_INTERVAL_MS = 500;
export const MAX_TOOL_RESULT_PREVIEW = 1500;
export const MAX_PLAN_PREVIEW = 3500;

// ---------------------------------------------------------------------------
// Renderers — pure functions, easy to unit-test.
// ---------------------------------------------------------------------------

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}

export function formatToolInput(input: Record<string, unknown>): string {
  try {
    const compact = JSON.stringify(input);
    return compact.length > 200 ? compact.slice(0, 200) + "…" : compact;
  } catch {
    return "{…}";
  }
}

export function renderToolCall(name: string, input: Record<string, unknown>): string {
  return `🔧 ${name}(${formatToolInput(input)})`;
}

export function renderToolResult(name: string, result: string, ok: boolean): string {
  const icon = ok ? "✓" : "✗";
  return `${icon} ${name}\n${truncate(result, MAX_TOOL_RESULT_PREVIEW)}`;
}

export function renderSystem(level: "info" | "warn" | "error", text: string): string {
  const icon = level === "error" ? "⚠️" : level === "warn" ? "⚠" : "ℹ";
  return `${icon} ${text}`;
}

// ---------------------------------------------------------------------------
// Sender — thin abstraction over the Bot API. Lets tests inject a fake.
// ---------------------------------------------------------------------------

export interface Sender {
  /** `topicId` is forwarded as Telegram's `message_thread_id` for forum chats. */
  send(
    chatId: string,
    text: string,
    replyMarkup?: InlineKeyboard,
    topicId?: string,
  ): Promise<{ messageId: number }>;
  edit(chatId: string, messageId: number, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// StreamingMessage — manages one in-flight assistant message per chat.
//
// First delta posts a new message. Subsequent deltas append to a buffer and
// schedule a debounced editMessageText. Edits never fire more often than
// MIN_EDIT_INTERVAL_MS. finalize() flushes any pending edit on turn end.
// ---------------------------------------------------------------------------

export class StreamingMessage {
  private buffer = "";
  private messageId: number | null = null;
  private lastEditAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstSend: Promise<void> | null = null;

  constructor(
    private readonly chatId: string,
    private readonly sender: Sender,
    private readonly minEditIntervalMs: number = MIN_EDIT_INTERVAL_MS,
    /** Forum topic id for the first send; editMessageText does not need it. */
    private readonly topicId?: string,
  ) {}

  pushDelta(delta: string): void {
    if (!delta) return;
    this.buffer += delta;
    if (!this.firstSend) {
      this.firstSend = this.sendFirst();
      return;
    }
    if (this.timer) return; // coalesce into the pending edit
    const wait = Math.max(0, this.minEditIntervalMs - (Date.now() - this.lastEditAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.commitEdit();
    }, wait);
  }

  private async sendFirst(): Promise<void> {
    try {
      const { messageId } = await this.sender.send(
        this.chatId, this.buffer, undefined, this.topicId,
      );
      this.messageId = messageId;
      this.lastEditAt = Date.now();
    } catch {
      // best-effort; keep messageId null so later edits short-circuit
    }
  }

  private async commitEdit(): Promise<void> {
    if (this.firstSend) await this.firstSend;
    if (this.messageId === null || this.buffer.length === 0) return;
    try {
      await this.sender.edit(this.chatId, this.messageId, this.buffer);
      this.lastEditAt = Date.now();
    } catch {
      // best-effort
    }
  }

  async finalize(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.commitEdit();
    this.messageId = null;
    this.buffer = "";
    this.firstSend = null;
  }

  // --- DraftStream verbs (issue 2) ---
  // The adapter remembers the current preview message id internally; callers
  // never touch it. update extends; flush commits now; materialize finalizes
  // the bubble as permanent; forceNewMessage starts a fresh bubble next time;
  // clear/stop drop in-flight tracking without deleting the message.

  update(delta: string): void {
    this.pushDelta(delta);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.commitEdit();
  }

  async materialize(): Promise<void> {
    await this.finalize();
  }

  forceNewMessage(): void {
    // Drop the in-flight references so the next update starts a brand-new
    // bubble. Does NOT delete the previously-sent message.
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.messageId = null;
    this.buffer = "";
    this.firstSend = null;
  }

  async clear(): Promise<void> {
    this.forceNewMessage();
  }

  async stop(): Promise<void> {
    this.forceNewMessage();
  }
}

// ---------------------------------------------------------------------------
// PromptRegistry — pending interactive prompts keyed by a short id that the
// inline-keyboard buttons embed in their callback_data.
// ---------------------------------------------------------------------------

interface PendingPrompt {
  kind: "confirm" | "plan_approval";
  resolve(reply: RemotePromptReply): void;
}

export class PromptRegistry {
  private pending = new Map<string, PendingPrompt>();
  private next = 0;

  register(kind: PendingPrompt["kind"]): { id: string; promise: Promise<RemotePromptReply> } {
    this.next += 1;
    const id = `p${this.next}`;
    const promise = new Promise<RemotePromptReply>((resolve) => {
      this.pending.set(id, { kind, resolve });
    });
    return { id, promise };
  }

  /** Called from the callback_query handler. Returns true if the id was known. */
  resolve(id: string, choiceId: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (p.kind === "confirm") {
      p.resolve({ kind: "confirm", allowed: choiceId === "allow" });
    } else {
      p.resolve({ kind: "plan_approval", choiceId });
    }
    return true;
  }
}

/** Parse "prompt:<id>:<choice>" from a callback_query.data string. */
export function parsePromptCallback(data: string): { id: string; choice: string } | null {
  const parts = data.split(":");
  if (parts.length < 3 || parts[0] !== "prompt") return null;
  return { id: parts[1]!, choice: parts.slice(2).join(":") };
}

/** Parse an inbound text message into a RemoteEvent (excluding the identity). */
export function parseInboundText(
  text: string,
  from: RemoteIdentity,
): RemoteEvent {
  if (text === "/stop") return { kind: "interrupt", from };
  if (text.startsWith("/")) {
    const spaceIdx = text.indexOf(" ");
    const name = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
    const args = spaceIdx > 0 ? text.slice(spaceIdx + 1) : "";
    return { kind: "command", from, name, args };
  }
  return { kind: "message", from, text };
}

/**
 * Streaming-message map key. Includes userId + topicId so two users in the
 * same group (or two topics in the same forum) keep separate in-flight
 * messages instead of corrupting each other's buffers.
 */
export function streamKey(id: RemoteIdentity): string {
  return `${id.chatId}:${id.topicId ?? ""}:${id.userId}`;
}

/**
 * Resolve `/cmd@botname args…` in group commands. Returns:
 *   - the original text if not a command, or a command with no `@` mention
 *   - the stripped text (`/cmd args…`) if the mention matches our bot
 *   - null if the mention targets a different bot (caller should drop)
 */
export function stripBotMention(text: string, ourUsername?: string): string | null {
  if (!text.startsWith("/")) return text;
  const spaceIdx = text.indexOf(" ");
  const nameSegment = spaceIdx > 0 ? text.slice(1, spaceIdx) : text.slice(1);
  const tail        = spaceIdx > 0 ? text.slice(spaceIdx) : "";
  const atIdx = nameSegment.indexOf("@");
  if (atIdx < 0) return text;
  const cmdName = nameSegment.slice(0, atIdx);
  const target  = nameSegment.slice(atIdx + 1);
  if (ourUsername && target.toLowerCase() === ourUsername.toLowerCase()) {
    return `/${cmdName}${tail}`;
  }
  return null;
}

/**
 * Extract Telegram's `message_thread_id` from an OutboundTarget.threadId
 * encoded as `"<chatId>:topic:<topicId>"`. Returns undefined when threadId
 * is absent or doesn't match the expected shape.
 */
export function parseTelegramThread(threadId: string | undefined): number | undefined {
  if (!threadId) return undefined;
  const m = threadId.match(/:topic:(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

/** Default row width when auto-chunking generic buttons into rows. */
export const TELEGRAM_BUTTONS_PER_ROW = 3;

/**
 * Normalize the two media-source fields (`mediaUrl` singular + `mediaUrls`
 * array) into a single list. The singular form is appended after the array
 * if both are present.
 */
export function normalizeMedia(
  one: string | undefined,
  many: ReadonlyArray<string> | undefined,
): string[] {
  const out: string[] = [];
  if (many) for (const m of many) out.push(m);
  if (one) out.push(one);
  return out;
}

/**
 * Collapse generic `OutboundInteractive` blocks into a flat button list,
 * auto-chunked into rows of TELEGRAM_BUTTONS_PER_ROW. Text blocks are
 * dropped here (they should be merged into the body text by the caller).
 * Selects are flattened to buttons. Placeholder text on selects is ignored
 * — Telegram inline keyboards don't have a placeholder slot.
 */
type AnyInteractiveBlock =
  | { type: "text";    text: string }
  | { type: "buttons"; buttons: ReadonlyArray<{ label: string; value: string }> }
  | {
      type: "select";
      placeholder?: string;
      options: ReadonlyArray<{ label: string; value: string }>;
    };

export function buildInteractiveKeyboardFromBlocks(
  blocks: ReadonlyArray<AnyInteractiveBlock>,
): InlineKeyboard | undefined {
  const flat: Array<{ label: string; value: string }> = [];
  for (const b of blocks) {
    if (b.type === "buttons" && b.buttons) flat.push(...b.buttons);
    else if (b.type === "select" && b.options) flat.push(...b.options);
  }
  if (flat.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (let i = 0; i < flat.length; i++) {
    if (i > 0 && i % TELEGRAM_BUTTONS_PER_ROW === 0) kb.row();
    kb.text(flat[i]!.label, flat[i]!.value);
  }
  return kb;
}

/**
 * Build a grammY InlineKeyboard from a Telegram-specific 2-D button array.
 * The caller controls layout fully; callback_data / url / future button
 * kinds pass through unchanged.
 */
export function buildInteractiveKeyboardFromTelegram(
  rows: ReadonlyArray<ReadonlyArray<{ text: string; callback_data?: string; url?: string }>>,
): InlineKeyboard | undefined {
  if (rows.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (let r = 0; r < rows.length; r++) {
    if (r > 0) kb.row();
    for (const btn of rows[r]!) {
      if (btn.url)               kb.url(btn.text, btn.url);
      else if (btn.callback_data) kb.text(btn.text, btn.callback_data);
    }
  }
  return kb;
}

// ---------------------------------------------------------------------------
// TelegramAdapter
// ---------------------------------------------------------------------------

/**
 * Pluggable DM access surface. The adapter calls these methods; the serve
 * process implements them against the live userMap + pairing.json state so
 * approvals take effect without restart.
 */
export interface DmAccessProvider {
  policy: DmPolicyKind;
  isKnown(userId: string): boolean;
  isPending(userId: string): boolean;
  /** Generate or reuse a pairing code for this stranger. */
  registerPending(req: {
    userId: string;
    username?: string;
    firstName?: string;
  }): string;
  /** Auto-add a user under `open` policy. */
  registerKnown(req: { userId: string; username?: string }): void;
}

export interface TelegramAdapterOptions {
  token: string;
  /** Override the sender (used in tests to skip the Bot API). */
  sender?: Sender;
  /** Dump every raw Update with truncation. */
  verbose?: boolean;
  /** Group/forum access rules. */
  access?: AccessSettings;
  /** DM access policy + state. Absent means DMs fall through to the gateway. */
  dm?: DmAccessProvider;
  /**
   * Flood-guard tuning. `false` disables the guard entirely (messages flow
   * straight through, useful for tests). Omitted = enabled with defaults.
   */
  flood?: Partial<FloodLimits> | false;
  /**
   * Where the flood guard persists abuse counters. Omitted = disabled (in
   * memory only). Production callers pass `~/.nexusclaw/flood-state.json`.
   */
  floodStatePath?: string;
  /**
   * Override the on-disk media store. Defaults to the process-wide singleton
   * rooted at `~/.nexusclaw/media`. Tests pass an isolated instance.
   */
  mediaStorage?: MediaStorage;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram";

  private bot: Bot;
  private sender: Sender;
  private handler: ((e: RemoteEvent) => void) | null = null;
  private streams = new Map<string, StreamingMessage>();
  /** Per-target draft cache, keyed by `chatId:threadId`. */
  private drafts = new Map<string, StreamingMessage>();
  private prompts = new PromptRegistry();
  private verbose: boolean;
  private access: AccessSettings;
  private dm: DmAccessProvider | null;
  private flood: FloodGuard | null;
  private pendingUpdateIds = new Set<number>();
  private sequentializer = new Sequentializer();
  private mediaStorage: MediaStorage;
  private token: string;
  /**
   * Per-sender FIFO of resolve callbacks. Each FloodGuard onFlush pushes one;
   * each outbound `turn_done` pops the oldest and calls it, which lets the
   * FloodGuard's dispatchOne unwind and release its pending slot.
   */
  private awaitingTurnDone = new Map<number, Array<() => void>>();

  constructor(opts: TelegramAdapterOptions) {
    this.bot = new Bot(opts.token);
    this.token = opts.token;
    this.sender = opts.sender ?? this.defaultSender();
    this.verbose = opts.verbose ?? false;
    this.access = opts.access ?? {};
    this.dm = opts.dm ?? null;
    this.mediaStorage = opts.mediaStorage ?? getDefaultMediaStorage();
    this.flood = opts.flood === false
      ? null
      : new FloodGuard(
          (msg, signal) => this.dispatchSynthetic(msg, signal),
          {
            limits: opts.flood ?? {},
            // Persistence off by default — opt-in via floodStatePath so
            // tests and ephemeral processes don't leak abuse history.
            statePath: opts.floodStatePath ?? null,
          },
        );
    this.wireHandlers();
  }

  // -------------------------------------------------------------------------
  // PlatformAdapter contract
  // -------------------------------------------------------------------------

  onEvent(h: (e: RemoteEvent) => void): void { this.handler = h; }

  async start(): Promise<void> {
    // bot.start() resolves only when the bot stops — fire-and-forget. A bad
    // token surfaces here as a rejection; catch it so it doesn't crash the
    // serve process and other adapters can keep running.
    this.bot.start().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`telegram: bot.start() failed — ${msg}`);
    });
  }

  async stop(): Promise<void> {
    this.flood?.stop();
    await this.bot.stop();
  }

  async send(to: RemoteIdentity, out: RemoteOutput): Promise<void> {
    switch (out.kind) {
      case "text": {
        const key = streamKey(to);
        let sm = this.streams.get(key);
        if (!sm) {
          sm = new StreamingMessage(to.chatId, this.sender, undefined, to.topicId);
          this.streams.set(key, sm);
        }
        sm.pushDelta(out.delta);
        return;
      }
      case "tool_call":
        await this.sender.send(to.chatId, renderToolCall(out.name, out.input), undefined, to.topicId);
        return;
      case "tool_result":
        await this.sender.send(to.chatId, renderToolResult(out.name, out.result, out.ok), undefined, to.topicId);
        return;
      case "system":
        await this.sender.send(to.chatId, renderSystem(out.level, out.text), undefined, to.topicId);
        return;
      case "turn_done": {
        const key = streamKey(to);
        const sm = this.streams.get(key);
        if (sm) {
          await sm.finalize();
          this.streams.delete(key);
        }
        // Resolve the oldest awaiting onFlush for this user. That unwinds
        // the FloodGuard's dispatchOne; its finally then releases the slot.
        // We log only — release ownership lives in the finally, not here.
        const userId = Number(to.userId);
        const queue = this.awaitingTurnDone.get(userId);
        if (queue && queue.length > 0) {
          const resolve = queue.shift()!;
          if (queue.length === 0) this.awaitingTurnDone.delete(userId);
          resolve();
        }
        this.flood?.logTurnDone(userId);
        return;
      }
    }
  }

  async prompt(p: RemotePrompt): Promise<RemotePromptReply> {
    if (p.kind === "confirm") {
      const { id, promise } = this.prompts.register("confirm");
      const kb = new InlineKeyboard()
        .text("Allow", `prompt:${id}:allow`)
        .text("Deny",  `prompt:${id}:deny`);
      await this.sender.send(p.to.chatId, `⚠️ ${p.message}`, kb, p.to.topicId);
      return promise;
    }
    const { id, promise } = this.prompts.register("plan_approval");
    const kb = new InlineKeyboard();
    for (const c of p.choices) kb.row().text(c.label, `prompt:${id}:${c.id}`);
    await this.sender.send(p.to.chatId, `📋 Plan:\n${truncate(p.planContent, MAX_PLAN_PREVIEW)}`, kb, p.to.topicId);
    return promise;
  }

  /**
   * Send a platform-neutral OutboundPayload. Converts markdown → Telegram
   * HTML, chunks at ≤ 4000 chars (balancing tags across split points),
   * denormalizes channelData into wire fields, parses threadId, and issues
   * one or more `sendMessage` calls.
   *
   * Per chunk, the retry safety net handles two known Telegram failures:
   *   • parse error          → retry with chunk.plainText, no parse_mode
   *   • thread-not-found     → retry without message_thread_id
   *
   * Only the FIRST chunk carries `reply_markup` and `reply_parameters` —
   * subsequent chunks are plain continuations.
   *
   * Returns the message id of the first sent chunk (the one with the
   * keyboard, if any).
   */
  async sendPayload(
    target: OutboundTarget,
    payload: OutboundPayload,
  ): Promise<{ messageId?: number }> {
    // 1. Convert markdown → HTML; append any `text` blocks from interactive.
    let body = markdownToTelegramHtml(payload.text);
    if (payload.interactive) {
      for (const blk of payload.interactive.blocks) {
        if (blk.type === "text") {
          const html = markdownToTelegramHtml(blk.text);
          body = body.length > 0 ? `${body}\n\n${html}` : html;
        }
      }
    }

    // 2a. Normalize media. If there's neither text nor media, no-op.
    const mediaUrls = normalizeMedia(payload.mediaUrl, payload.mediaUrls);
    if (body.length === 0 && mediaUrls.length === 0) return {};

    // 2b. Chunk into paired (htmlText, plainText) pieces. Used by both the
    //     text-only path and as caption material for media.
    const chunks = body.length > 0 ? chunkHtmlMessage(body) : [];

    // 3. Build wire-level options once.
    //    Keyboard precedence: telegram override beats generic blocks.
    const tgKb = payload.channelData?.telegram?.inlineKeyboard;
    const replyMarkup = tgKb
      ? buildInteractiveKeyboardFromTelegram(tgKb)
      : (payload.interactive
          ? buildInteractiveKeyboardFromBlocks(payload.interactive.blocks)
          : undefined);
    const messageThreadId = parseTelegramThread(target.threadId);
    const quoteText = payload.channelData?.telegram?.quoteText;
    const replyToId  = target.replyToId;

    // Reply linkage logic:
    //   id + quote → reply_parameters (real quote + parent link)
    //   id only    → older reply_to_message_id
    //   quote only → drop (Bot API rejects reply_parameters without message_id)
    //   neither    → no linkage
    let replyParameters:
      | { message_id: number; quote: string; quote_parse_mode: "HTML" }
      | undefined;
    let replyToMessageId: number | undefined;
    if (replyToId !== undefined && quoteText !== undefined) {
      replyParameters = { message_id: replyToId, quote: quoteText, quote_parse_mode: "HTML" };
    } else if (replyToId !== undefined) {
      replyToMessageId = replyToId;
    } else if (quoteText !== undefined) {
      console.warn(
        "telegram: quoteText without replyToId — dropping quote (Bot API requires message_id)",
      );
    }

    // 4. Media-first path: iterate mediaUrls; the first item carries the
    //    body as caption + the keyboard, subsequent items are media-only.
    //    forceDocument routes to sendDocument instead of sendPhoto.
    if (mediaUrls.length > 0) {
      // Caption can be up to 1024 chars in Telegram. Use the first chunk if
      // it fits; otherwise no caption (the long-text case is rare for media
      // replies and is a known gap).
      const caption = chunks[0] && chunks[0].htmlText.length <= 1024
        ? chunks[0].htmlText
        : undefined;
      let firstMessageId: number | undefined;
      const useDocument = !!payload.forceDocument;
      for (let i = 0; i < mediaUrls.length; i++) {
        const isFirst = i === 0;
        const opts: Record<string, unknown> = {};
        if (isFirst && caption) {
          opts.caption    = caption;
          opts.parse_mode = "HTML";
        }
        if (messageThreadId !== undefined) opts.message_thread_id = messageThreadId;
        if (payload.silent)                opts.disable_notification = true;
        if (isFirst && replyMarkup)        opts.reply_markup        = replyMarkup;
        if (isFirst && replyParameters)    opts.reply_parameters    = replyParameters;
        if (isFirst && replyToMessageId !== undefined && !replyParameters) {
          opts.reply_to_message_id = replyToMessageId;
        }
        const m = useDocument
          ? await this.bot.api.sendDocument(target.to, mediaUrls[i]!, opts as never)
          : await this.bot.api.sendPhoto(target.to, mediaUrls[i]!, opts as never);
        if (isFirst) firstMessageId = m.message_id;
      }
      return { messageId: firstMessageId };
    }

    // 5. Plain text path. Send each chunk with the retry safety net.
    //    Only the first chunk gets the keyboard / quote — subsequent
    //    chunks are continuations.
    let firstMessageId: number | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const isFirst = i === 0;
      // Small inter-chunk delay to respect Telegram's per-chat throttling.
      if (!isFirst) await new Promise((r) => setTimeout(r, 50));
      const opts: Record<string, unknown> = { parse_mode: "HTML" };
      if (messageThreadId !== undefined) opts.message_thread_id = messageThreadId;
      if (payload.silent)                opts.disable_notification = true;
      if (isFirst && replyMarkup)        opts.reply_markup        = replyMarkup;
      if (isFirst && replyParameters)    opts.reply_parameters    = replyParameters;
      if (isFirst && replyToMessageId !== undefined && !replyParameters) {
        opts.reply_to_message_id = replyToMessageId;
      }

      try {
        const m = await this.sendChunkWithRetries(target.to, chunk, opts);
        if (isFirst) firstMessageId = m;
      } catch (err) {
        // (6) partial-fail log — show which chunk in which sequence broke.
        if (chunks.length > 1) {
          console.error(
            `telegram: partial send — chunk ${i + 1}/${chunks.length} to ${target.to} failed`,
          );
        }
        throw err;
      }
    }

    return { messageId: firstMessageId };
  }

  /**
   * Return the per-target draft stream. Cached by `chatId:threadId` so
   * repeated calls for the same target return the same stream, letting the
   * adapter remember the in-flight messageId internally across updates.
   */
  draftFor(target: OutboundTarget): StreamingMessage {
    const key = `${target.to}:${target.threadId ?? ""}`;
    let s = this.drafts.get(key);
    if (!s) {
      const threadIdForSend = target.threadId !== undefined
        ? String(parseTelegramThread(target.threadId) ?? "")
        : undefined;
      s = new StreamingMessage(target.to, this.sender, undefined, threadIdForSend || undefined);
      this.drafts.set(key, s);
    }
    return s;
  }

  /**
   * Send one chunk; on a known Telegram error, retry once with the
   * appropriate workaround. Returns the resulting message id.
   */
  private async sendChunkWithRetries(
    chatId: string,
    chunk: OutboundChunk,
    opts: Record<string, unknown>,
  ): Promise<number> {
    try {
      const m = await this.bot.api.sendMessage(chatId, chunk.htmlText, opts as never);
      return m.message_id;
    } catch (err: unknown) {
      const desc = String((err as { description?: string }).description ?? "").toLowerCase();

      // Parse error → retry with plain text and no parse_mode.
      if (desc.includes("parse entities") || desc.includes("can't parse")) {
        console.error(`telegram: parse error from API — retrying chunk as plain text`);
        const plainOpts = { ...opts };
        delete plainOpts.parse_mode;
        const m = await this.bot.api.sendMessage(chatId, chunk.plainText, plainOpts as never);
        return m.message_id;
      }

      // Thread not found → retry without message_thread_id.
      if (desc.includes("thread not found") || desc.includes("message thread")) {
        console.error(`telegram: thread missing — retrying chunk without message_thread_id`);
        const noThreadOpts = { ...opts };
        delete noThreadOpts.message_thread_id;
        const m = await this.bot.api.sendMessage(chatId, chunk.htmlText, noThreadOpts as never);
        return m.message_id;
      }

      // Rate limited → wait the Retry-After hint and try once more.
      const errCode = (err as { error_code?: number }).error_code;
      const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after;
      if (errCode === 429 && typeof retryAfter === "number" && retryAfter > 0) {
        const waitMs = Math.min(retryAfter, 60) * 1000;
        console.error(`telegram: 429 rate limit — sleeping ${waitMs}ms before retry`);
        await new Promise((r) => setTimeout(r, waitMs));
        const m = await this.bot.api.sendMessage(chatId, chunk.htmlText, opts as never);
        return m.message_id;
      }

      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Download a media attachment, save it through MediaStorage, and forward
   * it to the gateway as a RemoteEvent.message. Runs out-of-band from the
   * grammY middleware so the long-poll loop isn't blocked on the HTTP fetch.
   *
   * Each call triggers a TTL sweep inside MediaStorage.save, so stale files
   * from prior turns get cleaned up at ingest time — no background timer.
   */
  private async dispatchMedia(
    source: TelegramMediaSource,
    rawText: string,
    from:   RemoteIdentity,
  ): Promise<void> {
    if (!this.handler) return;

    let ingested: IngestedMedia;
    try {
      ingested = await ingestTelegramMedia(source, {
        token:   this.token,
        storage: this.mediaStorage,
        getFile: (id) => this.bot.api.getFile(id) as Promise<{ file_path?: string; file_size?: number }>,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`telegram: media ingest failed for ${source.fileId} — ${msg}`);
      // Degrade gracefully: if the user attached a caption, still surface
      // it as a text-only event so their question isn't lost. Pure-media
      // messages with no caption drop here.
      const trimmed = rawText.trim();
      if (trimmed && this.handler) {
        this.handler({ kind: "message", from, text: trimmed });
      }
      return;
    }

    const shape = buildInboundShape(rawText, [ingested]);
    console.debug(
      `telegram: accept media (${source.kind}, ${ingested.saved.size}B) ` +
      `from ${from.userId} → ${ingested.saved.uri}` +
      (ingested.inlineEligible ? " [inline]" : " [marker]"),
    );

    this.handler({
      kind: "message",
      from,
      text: shape.text,
      ...(shape.content.length > 0 ? { content: shape.content } : {}),
    });
  }

  /**
   * Called by the FloodGuard's onFlush. Returns a promise that resolves
   * when the gateway fires `turn_done` for this sender (or rejects if the
   * janitor aborts the per-turn signal). The FloodGuard's dispatchOne
   * `finally` releases the pending slot on either outcome.
   */
  private async dispatchSynthetic(
    msg: SyntheticMessage,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.handler) return;

    const from: RemoteIdentity = {
      platform:  "telegram",
      userId:    String(msg.fromUser.id),
      chatId:    msg.chatId,
      messageId: msg.messageId,
      ...(msg.topicId !== undefined ? { topicId: msg.topicId } : {}),
    };
    console.debug(
      `telegram: accept from ${from.userId} in chat ${from.chatId}` +
      (from.topicId ? `/${from.topicId}` : "") +
      (msg.count > 1 ? ` (${msg.count} merged)` : ""),
    );

    const userId = msg.fromUser.id;
    let resolveTurnDone!: () => void;
    let rejectTurnDone!: (err: Error) => void;
    const turnDone = new Promise<void>((res, rej) => {
      resolveTurnDone = res;
      rejectTurnDone = rej;
    });
    const queue = this.awaitingTurnDone.get(userId) ?? [];
    queue.push(resolveTurnDone);
    this.awaitingTurnDone.set(userId, queue);

    const onAbort = (): void => {
      // Pull our resolve out of the queue so a later turn_done doesn't fire
      // a stale callback.
      const q = this.awaitingTurnDone.get(userId);
      if (q) {
        const i = q.indexOf(resolveTurnDone);
        if (i >= 0) q.splice(i, 1);
        if (q.length === 0) this.awaitingTurnDone.delete(userId);
      }
      rejectTurnDone(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort);

    const event = parseInboundText(msg.text, from);
    // Forward the per-turn signal so the gateway can pass it to agent.chat.
    if (event.kind === "message") event.signal = signal;
    this.handler(event);

    try {
      await turnDone;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private defaultSender(): Sender {
    return {
      send: async (chatId, text, replyMarkup, topicId) => {
        const m = await this.bot.api.sendMessage(chatId, text, {
          reply_markup: replyMarkup,
          ...(topicId !== undefined ? { message_thread_id: Number(topicId) } : {}),
        });
        return { messageId: m.message_id };
      },
      edit: async (chatId, messageId, text) => {
        await this.bot.api.editMessageText(chatId, messageId, text);
      },
    };
  }

  private wireHandlers(): void {
    // Inbound middleware — runs before any bot.on(...) handler matches.
    // Responsibilities: verbose-log the raw Update, discard duplicates by
    // update_id, and gate downstream handlers through the Sequentializer
    // so updates dispatch strictly one at a time.
    this.bot.use(async (ctx, next) => {
      if (this.verbose) verboseLogUpdate(ctx.update);
      const id = ctx.update.update_id;
      if (this.pendingUpdateIds.has(id)) {
        console.debug(`telegram: discarding duplicate update ${id}`);
        return;
      }
      this.pendingUpdateIds.add(id);
      try {
        await this.sequentializer.submit(() => next());
      } finally {
        this.pendingUpdateIds.delete(id);
      }
    });

    this.bot.on("message", async (ctx) => {
      if (!ctx.from || !ctx.chat) return;

      // Drop self-echoed messages defensively (e.g. multi-bot / forwarded).
      if (isSelfMessage(ctx.from.id, ctx.me.id)) return;

      const space = classifyChat(ctx.chat, ctx.message);
      if (space.kind === "channel") return;

      // Access checks run BEFORE we inspect message content. Unauthorized
      // senders never trigger any media-specific processing.
      if (space.kind !== "dm") {
        const decision = checkGroupAccess(space, String(ctx.from.id), this.access);
        if (!decision.allowed) {
          console.debug(
            `telegram: dropping ${space.kind} message from ${ctx.from.id} ` +
            `in chat ${ctx.chat.id} — ${decision.reason}`,
          );
          return;
        }
      } else if (this.dm) {
        const userId = String(ctx.from.id);
        const decision = checkDmAccess(userId, {
          policy: this.dm.policy,
          isKnown:   (id) => this.dm!.isKnown(id),
          isPending: (id) => this.dm!.isPending(id),
        });
        if (decision.kind === "drop") {
          console.debug(`telegram: dropping dm from ${userId} — ${decision.reason}`);
          return;
        }
        if (decision.kind === "pair_prompt") {
          // Pairing prompts respect the same per-sender rate budget as the
          // regular inbound — a stranger can't infinite-spam pairing replies.
          if (this.flood && !this.flood.tryRateOnly(Number(userId)).ok) {
            console.debug(`telegram: rate-limited pairing prompt for ${userId}`);
            return;
          }
          const code = this.dm.registerPending({
            userId,
            username:  ctx.from.username,
            firstName: ctx.from.first_name,
          });
          void this.sender.send(String(ctx.chat.id), formatPairingPrompt(userId, code));
          return;
        }
        if (decision.kind === "allow_and_register") {
          this.dm.registerKnown({ userId, username: ctx.from.username });
        }
      }

      // Access granted. Branch on whether the message carries media. Media
      // and text-only paths share access/rate gates but diverge after: text
      // goes through the FloodGuard's debounce-and-merge pipeline; media
      // skips debouncing (each attachment is a distinct intent) and
      // dispatches once the download completes.
      const mediaSource = detectMedia(ctx.message);
      const rawText = ctx.message.text ?? ctx.message.caption ?? "";

      if (mediaSource) {
        // Rate-only check — pending-cap and debounce don't apply. A user
        // sending a flurry of photos still gets rate-limited at the
        // per-minute slot.
        if (this.flood && !this.flood.tryRateOnly(ctx.from.id).ok) {
          console.debug(`telegram: rate-limited media from ${ctx.from.id}`);
          return;
        }
        const from: RemoteIdentity = {
          platform: "telegram",
          userId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          messageId: ctx.message.message_id,
          ...(space.kind === "forum" ? { topicId: space.topicId } : {}),
        };
        await this.dispatchMedia(mediaSource, rawText, from);
        return;
      }

      if (rawText === "") {
        console.debug(
          `telegram: dropping non-text message from ${ctx.from.id} — no text, caption, or media`,
        );
        return;
      }

      // Resolve /cmd@botname in groups before parsing.
      const cleaned = stripBotMention(rawText, ctx.me.username);
      if (cleaned === null) return;  // command was addressed to another bot
      if (cleaned.trim() === "") {
        console.debug(`telegram: dropping empty message from ${ctx.from.id}`);
        return;
      }

      // Flood-guard path: try to accept; on success the FloodGuard will fire
      // its onFlush callback (dispatchSynthetic) after the debounce window.
      // On rejection it has already logged the abuse line.
      if (this.flood) {
        const decision = this.flood.tryAccept({
          text:      cleaned,
          chatId:    String(ctx.chat.id),
          topicId:   space.kind === "forum" ? space.topicId : undefined,
          fromUser:  {
            id: ctx.from.id,
            username:   ctx.from.username,
            first_name: ctx.from.first_name,
          },
          date:      ctx.message.date,
          messageId: ctx.message.message_id,
        });
        if (!decision.ok) {
          console.debug(`telegram: flood-rejected ${ctx.from.id} (${decision.code})`);
        }
        return;
      }

      // No flood guard — direct dispatch (used by tests with flood: false).
      if (!this.handler) return;
      const from: RemoteIdentity = {
        platform: "telegram",
        userId: String(ctx.from.id),
        chatId: String(ctx.chat.id),
        messageId: ctx.message.message_id,
        ...(space.kind === "forum" ? { topicId: space.topicId } : {}),
      };
      console.debug(
        `telegram: accept from ${from.userId} in chat ${from.chatId}` +
        (from.topicId ? `/${from.topicId}` : ""),
      );
      this.handler(parseInboundText(cleaned, from));
    });

    // Subscribe to edits so the wire delivers them — middleware then logs
    // and dedups them. By design we do not forward edits to the agent.
    this.bot.on("edited_message", () => {});

    // Subscribe to membership changes affecting the bot itself. grammY only
    // includes this in allowed_updates when there's a registered handler.
    // We just log so operators notice the bot being added/removed somewhere.
    this.bot.on("my_chat_member", (ctx) => {
      const chat = ctx.chat;
      const status = ctx.myChatMember.new_chat_member.status;
      const actor = ctx.from?.id ?? "?";
      console.error(
        `telegram: my_chat_member — chat ${chat.id} (${chat.type}) → ${status} ` +
        `(by user ${actor})`,
      );
    });

    this.bot.on("callback_query:data", async (ctx) => {
      // Always answer first so the user's loading spinner clears, even if
      // we end up dropping the payload.
      try { await ctx.answerCallbackQuery(); } catch { /* best-effort */ }

      if (!ctx.from || !ctx.chat) return;
      if (isSelfMessage(ctx.from.id, ctx.me.id)) return;

      // The originating message carries the thread id for forum chats.
      const cbMessage = ctx.callbackQuery.message ?? {};
      const space = classifyChat(ctx.chat, cbMessage);
      if (space.kind === "channel") return;

      const userId = String(ctx.from.id);
      if (space.kind !== "dm") {
        const decision = checkGroupAccess(space, userId, this.access);
        if (!decision.allowed) {
          console.debug(
            `telegram: dropping callback_query from ${userId} ` +
            `in chat ${ctx.chat.id} — ${decision.reason}`,
          );
          return;
        }
      } else if (this.dm) {
        // DM callbacks only make sense for already-known users — strangers
        // have no in-flight prompts to resolve, and `disable` blocks all.
        if (this.dm.policy === "disable" || !this.dm.isKnown(userId)) {
          console.debug(
            `telegram: dropping callback_query from ${userId} — not allowed in DM`,
          );
          return;
        }
      }

      const parsed = parsePromptCallback(ctx.callbackQuery.data);
      if (parsed) this.prompts.resolve(parsed.id, parsed.choice);
    });
  }
}
