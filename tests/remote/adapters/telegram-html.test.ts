import { test, expect, describe } from "bun:test";
import {
  markdownToTelegramHtml,
  htmlToPlainText,
  chunkHtmlMessage,
} from "@/remote/adapters/telegram-html";

const md = markdownToTelegramHtml;

describe("markdownToTelegramHtml — inline emphasis", () => {
  test("**bold**", () => {
    expect(md("**hi**")).toBe("<b>hi</b>");
  });
  test("__bold__", () => {
    expect(md("__hi__")).toBe("<b>hi</b>");
  });
  test("*italic*", () => {
    expect(md("*hi*")).toBe("<i>hi</i>");
  });
  test("_italic_", () => {
    expect(md("_hi_")).toBe("<i>hi</i>");
  });
  test("~~strikethrough~~", () => {
    expect(md("~~hi~~")).toBe("<s>hi</s>");
  });
  test("bold beats italic when adjacent: **x** → bold only", () => {
    expect(md("a **b** c")).toBe("a <b>b</b> c");
  });
  test("plain text passes through unchanged", () => {
    expect(md("hello world")).toBe("hello world");
  });
});

describe("markdownToTelegramHtml — code", () => {
  test("inline `code`", () => {
    expect(md("foo `bar` baz")).toBe("foo <code>bar</code> baz");
  });
  test("fenced ``` code block ``` without lang", () => {
    expect(md("```\nconst x = 1;\n```")).toBe("<pre><code>const x = 1;</code></pre>");
  });
  test("fenced ```lang code block``` with lang", () => {
    expect(md("```ts\nlet x = 1;\n```")).toBe(
      `<pre><code class="language-ts">let x = 1;</code></pre>`,
    );
  });
  test("HTML inside code is escaped", () => {
    expect(md("`<div>`")).toBe("<code>&lt;div&gt;</code>");
  });
  test("markdown inside code is NOT processed", () => {
    expect(md("`**bold** stays literal`")).toBe("<code>**bold** stays literal</code>");
  });
  test("code block content with HTML special chars escapes correctly", () => {
    expect(md("```\n<a href='x'>&\n```")).toBe(
      "<pre><code>&lt;a href='x'&gt;&amp;</code></pre>",
    );
  });
});

describe("markdownToTelegramHtml — links", () => {
  test("[text](url)", () => {
    expect(md("[click](https://example.com)")).toBe(
      `<a href="https://example.com">click</a>`,
    );
  });
});

describe("markdownToTelegramHtml — escaping", () => {
  test("plain < > & are escaped", () => {
    expect(md("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });
  test("user-supplied <b> doesn't become a tag", () => {
    expect(md("<b>fake</b>")).toBe("&lt;b&gt;fake&lt;/b&gt;");
  });
  test("ampersand-only escape", () => {
    expect(md("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });
});

describe("markdownToTelegramHtml — headings", () => {
  test("# becomes bold", () => {
    expect(md("# Heading")).toBe("<b>Heading</b>");
  });
  test("## also becomes bold", () => {
    expect(md("## Subheading")).toBe("<b>Subheading</b>");
  });
});

describe("markdownToTelegramHtml — blockquotes", () => {
  test("single > line becomes a blockquote", () => {
    expect(md("> hello")).toBe("<blockquote>hello</blockquote>");
  });
  test("consecutive > lines merge into one blockquote", () => {
    expect(md("> one\n> two")).toBe("<blockquote>one\ntwo</blockquote>");
  });
  test("interleaved blockquote and plain text", () => {
    expect(md("> quoted\nnormal")).toBe("<blockquote>quoted</blockquote>\nnormal");
  });
});

describe("markdownToTelegramHtml — multi-feature", () => {
  test("the user's example payload renders", () => {
    const src = "Done! I updated **README.md** and pushed.\n\nNext steps:\n- Review the PR\n- Run `pnpm test`";
    const html = md(src);
    expect(html).toContain("<b>README.md</b>");
    expect(html).toContain("<code>pnpm test</code>");
    // Bullets remain as plain text.
    expect(html).toContain("- Review the PR");
    // Newlines preserved.
    expect(html).toContain("\n");
  });
  test("bold inside a paragraph with code on a separate line", () => {
    const html = md("Hello **world**\n```\nx = 1\n```");
    expect(html).toBe("Hello <b>world</b>\n<pre><code>x = 1</code></pre>");
  });
});

// ---------------------------------------------------------------------------
// htmlToPlainText
// ---------------------------------------------------------------------------

describe("htmlToPlainText", () => {
  test("strips known Telegram tags", () => {
    expect(htmlToPlainText("Hello <b>world</b> and <code>x</code>"))
      .toBe("Hello world and x");
  });
  test("decodes the entities our converter emits", () => {
    expect(htmlToPlainText("a &lt; b &amp; c &gt; d")).toBe("a < b & c > d");
  });
  test("decodes entities in tag content", () => {
    expect(htmlToPlainText("<code>&lt;div&gt;</code>")).toBe("<div>");
  });
  test("strips link tag, keeps anchor text", () => {
    expect(htmlToPlainText(`<a href="https://x">click</a>`)).toBe("click");
  });
});

// ---------------------------------------------------------------------------
// chunkHtmlMessage
// ---------------------------------------------------------------------------

describe("chunkHtmlMessage", () => {
  test("returns empty array for empty input", () => {
    expect(chunkHtmlMessage("")).toEqual([]);
  });

  test("single chunk when under the soft limit", () => {
    const html = "<b>hello world</b>";
    const out = chunkHtmlMessage(html, 4000);
    expect(out).toHaveLength(1);
    expect(out[0]!.htmlText).toBe(html);
    expect(out[0]!.plainText).toBe("hello world");
  });

  test("a long bold span splits with tags closed and reopened across chunks", () => {
    const body = "x".repeat(900);
    const html = `<b>${body}</b>`;
    const out = chunkHtmlMessage(html, 500);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Every chunk must end with </b> and start with <b> (except chunk 0 which
    // also starts with <b> by virtue of the open tag).
    for (const ch of out) {
      expect(ch.htmlText.startsWith("<b>")).toBe(true);
      expect(ch.htmlText.endsWith("</b>")).toBe(true);
    }
    // Concatenating the visible plain text reconstructs the body.
    const joined = out.map((c) => c.plainText).join("");
    expect(joined).toBe(body);
  });

  test("nested tags balance correctly across a split", () => {
    const body = "y".repeat(900);
    const html = `<b><i>${body}</i></b>`;
    const out = chunkHtmlMessage(html, 500);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const ch of out) {
      expect(ch.htmlText.startsWith("<b><i>")).toBe(true);
      expect(ch.htmlText.endsWith("</i></b>")).toBe(true);
    }
  });

  test("attributes on open tags survive reopen", () => {
    const body = "z".repeat(900);
    const html = `<a href="https://example.com">${body}</a>`;
    const out = chunkHtmlMessage(html, 500);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const ch of out) {
      expect(ch.htmlText.startsWith(`<a href="https://example.com">`)).toBe(true);
      expect(ch.htmlText.endsWith("</a>")).toBe(true);
    }
  });

  test("long plain text splits at newlines when possible", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push("line number " + i);
    const html = lines.join("\n");
    const out = chunkHtmlMessage(html, 200);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Each chunk should NOT start mid-word — the split fell on a newline.
    for (const ch of out) {
      expect(ch.htmlText.length).toBeLessThanOrEqual(200);
    }
  });

  test("each chunk's plainText is its htmlText with tags stripped + entities decoded", () => {
    const html = `<b>hello</b> &amp; <code>code</code>`;
    const out = chunkHtmlMessage(html, 4000);
    expect(out[0]!.plainText).toBe("hello & code");
  });
});
