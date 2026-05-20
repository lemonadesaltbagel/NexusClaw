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
  PlatformAdapter,
  RemoteEvent,
  RemoteIdentity,
  RemoteOutput,
  RemotePrompt,
  RemotePromptReply,
} from "@/remote/types";

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
  send(chatId: string, text: string, replyMarkup?: InlineKeyboard): Promise<{ messageId: number }>;
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
      const { messageId } = await this.sender.send(this.chatId, this.buffer);
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

// ---------------------------------------------------------------------------
// TelegramAdapter
// ---------------------------------------------------------------------------

export interface TelegramAdapterOptions {
  token: string;
  /** Override the sender (used in tests to skip the Bot API). */
  sender?: Sender;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram";

  private bot: Bot;
  private sender: Sender;
  private handler: ((e: RemoteEvent) => void) | null = null;
  private streams = new Map<string, StreamingMessage>();
  private prompts = new PromptRegistry();

  constructor(opts: TelegramAdapterOptions) {
    this.bot = new Bot(opts.token);
    this.sender = opts.sender ?? this.defaultSender();
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
    await this.bot.stop();
  }

  async send(to: RemoteIdentity, out: RemoteOutput): Promise<void> {
    switch (out.kind) {
      case "text": {
        let sm = this.streams.get(to.chatId);
        if (!sm) {
          sm = new StreamingMessage(to.chatId, this.sender);
          this.streams.set(to.chatId, sm);
        }
        sm.pushDelta(out.delta);
        return;
      }
      case "tool_call":
        await this.sender.send(to.chatId, renderToolCall(out.name, out.input));
        return;
      case "tool_result":
        await this.sender.send(to.chatId, renderToolResult(out.name, out.result, out.ok));
        return;
      case "system":
        await this.sender.send(to.chatId, renderSystem(out.level, out.text));
        return;
      case "turn_done": {
        const sm = this.streams.get(to.chatId);
        if (sm) {
          await sm.finalize();
          this.streams.delete(to.chatId);
        }
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
      await this.sender.send(p.to.chatId, `⚠️ ${p.message}`, kb);
      return promise;
    }
    const { id, promise } = this.prompts.register("plan_approval");
    const kb = new InlineKeyboard();
    for (const c of p.choices) kb.row().text(c.label, `prompt:${id}:${c.id}`);
    await this.sender.send(p.to.chatId, `📋 Plan:\n${truncate(p.planContent, MAX_PLAN_PREVIEW)}`, kb);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private defaultSender(): Sender {
    return {
      send: async (chatId, text, replyMarkup) => {
        const m = await this.bot.api.sendMessage(chatId, text, {
          reply_markup: replyMarkup,
        });
        return { messageId: m.message_id };
      },
      edit: async (chatId, messageId, text) => {
        await this.bot.api.editMessageText(chatId, messageId, text);
      },
    };
  }

  private wireHandlers(): void {
    this.bot.on("message:text", (ctx) => {
      if (!this.handler || !ctx.from || !ctx.chat) return;
      const from: RemoteIdentity = {
        platform: "telegram",
        userId: String(ctx.from.id),
        chatId: String(ctx.chat.id),
      };
      this.handler(parseInboundText(ctx.message.text, from));
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const parsed = parsePromptCallback(ctx.callbackQuery.data);
      if (parsed) this.prompts.resolve(parsed.id, parsed.choice);
      try { await ctx.answerCallbackQuery(); } catch { /* best-effort */ }
    });
  }
}
