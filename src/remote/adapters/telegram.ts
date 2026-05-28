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

/**
 * Build a grammY InlineKeyboard from an OutboundInteractive's options.
 * Each option is one button; `value` becomes the button's callback_data.
 * Buttons lay out in a single row for now.
 */
export function buildInteractiveKeyboard(
  options: ReadonlyArray<{ label: string; value: string }>,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const opt of options) kb.text(opt.label, opt.value);
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
}

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram";

  private bot: Bot;
  private sender: Sender;
  private handler: ((e: RemoteEvent) => void) | null = null;
  private streams = new Map<string, StreamingMessage>();
  private prompts = new PromptRegistry();
  private verbose: boolean;
  private access: AccessSettings;
  private dm: DmAccessProvider | null;
  private flood: FloodGuard | null;
  private pendingUpdateIds = new Set<number>();
  private sequentializer = new Sequentializer();
  /**
   * Per-sender FIFO of resolve callbacks. Each FloodGuard onFlush pushes one;
   * each outbound `turn_done` pops the oldest and calls it, which lets the
   * FloodGuard's dispatchOne unwind and release its pending slot.
   */
  private awaitingTurnDone = new Map<number, Array<() => void>>();

  constructor(opts: TelegramAdapterOptions) {
    this.bot = new Bot(opts.token);
    this.sender = opts.sender ?? this.defaultSender();
    this.verbose = opts.verbose ?? false;
    this.access = opts.access ?? {};
    this.dm = opts.dm ?? null;
    this.flood = opts.flood === false
      ? null
      : new FloodGuard(
          (msg, signal) => this.dispatchSynthetic(msg, signal),
          { limits: opts.flood ?? {} },
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
    // 1. Convert markdown → HTML; append interactive prompt to body.
    let body = markdownToTelegramHtml(payload.text);
    if (payload.interactive) {
      const promptHtml = markdownToTelegramHtml(payload.interactive.prompt);
      body = body.length > 0 ? `${body}\n\n${promptHtml}` : promptHtml;
    }

    // 2. Chunk into paired (htmlText, plainText) pieces.
    const chunks = chunkHtmlMessage(body);
    if (chunks.length === 0) return {};

    // 3. Build wire-level options once.
    const replyMarkup = payload.interactive
      ? buildInteractiveKeyboard(payload.interactive.options)
      : undefined;
    const messageThreadId = parseTelegramThread(target.threadId);
    const quoteText = payload.channelData?.telegram?.quoteText;
    const replyParameters = quoteText !== undefined
      ? { quote: quoteText, quote_parse_mode: "HTML" as const }
      : undefined;

    // 4. Send each chunk with the retry safety net. Only the first chunk
    //    gets the keyboard / quote — subsequent chunks are continuations.
    let firstMessageId: number | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const isFirst = i === 0;
      const opts: Record<string, unknown> = { parse_mode: "HTML" };
      if (messageThreadId !== undefined) opts.message_thread_id = messageThreadId;
      if (isFirst && replyMarkup)        opts.reply_markup = replyMarkup;
      if (isFirst && replyParameters)    opts.reply_parameters = replyParameters;

      const m = await this.sendChunkWithRetries(target.to, chunk, opts);
      if (isFirst) firstMessageId = m;
    }

    return { messageId: firstMessageId };
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

      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
      platform: "telegram",
      userId:   String(msg.fromUser.id),
      chatId:   msg.chatId,
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

    this.bot.on("message", (ctx) => {
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

      // Access granted. Pick up the user's text from either `text` (plain
      // text message) or `caption` (text attached to a photo/video/document).
      // The media itself is dropped — agent core does not yet handle it.
      const text = ctx.message.text ?? ctx.message.caption;
      if (text === undefined) {
        console.debug(
          `telegram: dropping non-text message from ${ctx.from.id} — no text or caption`,
        );
        return;
      }

      // Resolve /cmd@botname in groups before parsing.
      const cleaned = stripBotMention(text, ctx.me.username);
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
