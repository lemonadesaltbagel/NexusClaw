// ---------------------------------------------------------------------------
// Markdown → Telegram HTML converter.
//
// Telegram supports a small fixed subset of HTML in `parse_mode: "HTML"`
// messages (see https://core.telegram.org/bots/api#html-style). This module
// translates the agent's markdown output into that subset, preserving:
//
//   **bold** / __bold__       → <b>…</b>
//   *italic* / _italic_       → <i>…</i>
//   ~~strikethrough~~         → <s>…</s>
//   `inline code`             → <code>…</code>
//   ```lang\n…\n```           → <pre><code class="language-lang">…</code></pre>
//   [text](url)               → <a href="url">text</a>
//   # heading                 → <b>heading</b>  (Telegram has no headings)
//   > blockquote              → <blockquote>…</blockquote>
//
// Lists are left as plain text (Telegram has no list tag); the `-` /
// numbered prefixes survive as-is and render fine.
//
// HTML special characters (`<`, `>`, `&`) in plain text are escaped. Inside
// code (block or inline), the original characters are preserved and
// escaped only at restoration time so `<div>` inside a code block renders
// literally rather than as a tag.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Sentinels: alphanumeric + underscore so they survive HTML escaping and
// won't collide with markdown patterns. We strip these prefixes from the
// input if they happen to occur naturally.
const CB_TAG = "__NXC_CB_";
const IC_TAG = "__NXC_IC_";
const TAG_END = "__";

export function markdownToTelegramHtml(md: string): string {
  // Defensive: strip occurrences of our placeholder tags from user input.
  let s = md.replace(new RegExp(CB_TAG, "g"), "").replace(new RegExp(IC_TAG, "g"), "");

  // 1. Extract fenced code blocks. Save raw content so it survives the
  //    escaping/transform pass intact.
  const codeBlocks: Array<{ lang: string; text: string }> = [];
  s = s.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_match, lang, text) => {
    const idx = codeBlocks.length;
    codeBlocks.push({
      lang: String(lang ?? ""),
      text: String(text ?? "").replace(/\n$/, ""),
    });
    return `${CB_TAG}${idx}${TAG_END}`;
  });

  // 2. Extract inline code.
  const inlineCode: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_match, text) => {
    const idx = inlineCode.length;
    inlineCode.push(String(text));
    return `${IC_TAG}${idx}${TAG_END}`;
  });

  // 3. Escape HTML special characters in remaining text.
  s = escapeHtml(s);

  // 4. Inline emphasis. Order matters — handle ** / __ before * / _ so
  //    bold doesn't get partially matched as italic.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  s = s.replace(/(?<![\*\w])\*([^*\n]+?)\*(?![\*\w])/g, "<i>$1</i>");
  s = s.replace(/(?<![_\w])_([^_\n]+?)_(?![_\w])/g, "<i>$1</i>");

  // Links: [text](url). url may contain ) only if URL-encoded.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_match, text, url) => {
    return `<a href="${url}">${text}</a>`;
  });

  // 5. Block-level: headings, blockquotes. The block markers were escaped
  //    in step 3, so we look for the escaped forms (`&gt;` and `#`).
  const lines = s.split("\n");
  const out: string[] = [];
  let blockquote: string[] = [];

  const flushBlockquote = (): void => {
    if (blockquote.length > 0) {
      out.push(`<blockquote>${blockquote.join("\n")}</blockquote>`);
      blockquote = [];
    }
  };

  for (const line of lines) {
    if (/^&gt;\s?/.test(line)) {
      blockquote.push(line.replace(/^&gt;\s?/, ""));
      continue;
    }
    flushBlockquote();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      out.push(`<b>${heading[2]}</b>`);
    } else {
      out.push(line);
    }
  }
  flushBlockquote();
  s = out.join("\n");

  // 6. Restore code blocks and inline code with HTML-escaped content.
  s = s.replace(new RegExp(`${CB_TAG}(\\d+)${TAG_END}`, "g"), (_match, i) => {
    const cb = codeBlocks[Number(i)]!;
    const escaped = escapeHtml(cb.text);
    const langAttr = cb.lang ? ` class="language-${escapeHtml(cb.lang)}"` : "";
    return `<pre><code${langAttr}>${escaped}</code></pre>`;
  });
  s = s.replace(new RegExp(`${IC_TAG}(\\d+)${TAG_END}`, "g"), (_match, i) => {
    return `<code>${escapeHtml(inlineCode[Number(i)]!)}</code>`;
  });

  return s;
}

// ---------------------------------------------------------------------------
// Plain-text fallback — strip HTML tags and decode the entities our
// converter produces. Used as the safety-net body when Telegram rejects
// an HTML message with a parse error.
// ---------------------------------------------------------------------------

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&amp;/g,  "&");  // & last to avoid double-decoding
}

// ---------------------------------------------------------------------------
// Chunking — Telegram caps a single message at 4096 characters. We chunk
// at ≤ MAX_CHUNK_HTML_LENGTH and balance any tags that straddle a split
// point: close the current open stack at the end of chunk N and re-open
// the same tags at the start of chunk N+1. Each chunk is paired with a
// plain-text version that the retry path can fall back to when Telegram
// rejects the HTML.
// ---------------------------------------------------------------------------

/** Soft limit; leaves ~96 chars of headroom under Telegram's 4096 hard cap. */
export const MAX_CHUNK_HTML_LENGTH = 4000;

/** Reserved bytes per chunk for the closing-tag suffix the splitter appends. */
const CLOSE_RESERVE = 400;

export interface OutboundChunk {
  /** HTML body for the chunk, with all open tags closed at the end. */
  htmlText: string;
  /** Plain-text body for the same chunk — fallback when parse_mode fails. */
  plainText: string;
}

interface OpenTag { name: string; raw: string }
interface TokenOpen  { kind: "open";  raw: string; name: string }
interface TokenClose { kind: "close"; raw: string; name: string }
interface TokenText  { kind: "text";  raw: string }
type Token = TokenOpen | TokenClose | TokenText;

function tokenizeHtml(html: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) {
        out.push({ kind: "text", raw: html.slice(i) });
        break;
      }
      const raw = html.slice(i, end + 1);
      const isClose = raw[1] === "/";
      const inner = raw.slice(isClose ? 2 : 1, -1).trim();
      const nameMatch = inner.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      const name = nameMatch ? nameMatch[0] : "";
      out.push(isClose ? { kind: "close", raw, name } : { kind: "open", raw, name });
      i = end + 1;
    } else {
      const next = html.indexOf("<", i);
      if (next < 0) {
        out.push({ kind: "text", raw: html.slice(i) });
        break;
      }
      if (next > i) out.push({ kind: "text", raw: html.slice(i, next) });
      i = next;
    }
  }
  return out;
}

export function chunkHtmlMessage(
  html: string,
  maxSize: number = MAX_CHUNK_HTML_LENGTH,
): OutboundChunk[] {
  if (html.length === 0) return [];
  if (html.length <= maxSize) {
    return [{ htmlText: html, plainText: htmlToPlainText(html) }];
  }

  const softMax = Math.max(1, maxSize - CLOSE_RESERVE);
  const tokens = tokenizeHtml(html);
  const chunks: OutboundChunk[] = [];
  const openStack: OpenTag[] = [];
  let buffer = "";

  const closings = (): string => {
    let s = "";
    for (let i = openStack.length - 1; i >= 0; i--) s += `</${openStack[i]!.name}>`;
    return s;
  };
  const reopens = (): string => openStack.map((t) => t.raw).join("");

  const flush = (): void => {
    if (buffer.length === 0) return;
    const htmlText = buffer + closings();
    chunks.push({ htmlText, plainText: htmlToPlainText(htmlText) });
    buffer = reopens();
  };

  for (const tok of tokens) {
    if (tok.kind === "open") {
      if (buffer.length + tok.raw.length > softMax && buffer.length > 0) flush();
      buffer += tok.raw;
      openStack.push({ name: tok.name, raw: tok.raw });
    } else if (tok.kind === "close") {
      if (buffer.length + tok.raw.length > softMax && buffer.length > 0) flush();
      buffer += tok.raw;
      // Pop the matching open from the top of the stack.
      const top = openStack[openStack.length - 1];
      if (top && top.name === tok.name) openStack.pop();
    } else {
      // Text — splittable at newlines / spaces.
      let remaining = tok.raw;
      while (buffer.length + remaining.length > softMax) {
        const room = softMax - buffer.length;
        if (room <= 0) {
          flush();
          continue;
        }
        // Prefer newline, then space, then hard cut.
        let cut = remaining.lastIndexOf("\n", room);
        if (cut < 0 || cut < room * 0.5) cut = remaining.lastIndexOf(" ", room);
        if (cut <= 0) cut = room;
        buffer += remaining.slice(0, cut);
        remaining = remaining.slice(cut);
        flush();
      }
      buffer += remaining;
    }
  }

  if (buffer.length > 0 || openStack.length > 0) {
    const htmlText = buffer + closings();
    chunks.push({ htmlText, plainText: htmlToPlainText(htmlText) });
  }

  return chunks;
}
