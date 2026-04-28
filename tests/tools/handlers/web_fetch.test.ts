import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { webFetch } from "@/tools/handlers/web_fetch";

// ---------------------------------------------------------------------------
// Mock fetch globally so tests don't make real HTTP requests
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(
  body: string,
  options: { status?: number; statusText?: string; contentType?: string } = {},
) {
  const { status = 200, statusText = "OK", contentType = "text/plain" } = options;
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(body, {
        status,
        statusText,
        headers: { "content-type": contentType },
      }),
    ),
  ) as any;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Basic fetching
// ---------------------------------------------------------------------------

describe("webFetch", () => {
  test("returns plain text content", async () => {
    mockFetch("hello world");
    const result = await webFetch({ url: "https://example.com/data.txt" });
    expect(result).toBe("hello world");
  });

  test("returns (empty response) for empty body", async () => {
    mockFetch("");
    const result = await webFetch({ url: "https://example.com/empty" });
    expect(result).toBe("(empty response)");
  });

  test("returns HTTP error for non-ok responses", async () => {
    mockFetch("", { status: 404, statusText: "Not Found" });
    const result = await webFetch({ url: "https://example.com/missing" });
    expect(result).toBe("HTTP error: 404 Not Found");
  });

  // ---------------------------------------------------------------------------
  // HTML stripping
  // ---------------------------------------------------------------------------

  test("strips HTML tags from html content", async () => {
    mockFetch("<html><body><p>Hello</p></body></html>", {
      contentType: "text/html",
    });
    const result = await webFetch({ url: "https://example.com" });
    expect(result).toContain("Hello");
    expect(result).not.toContain("<p>");
    expect(result).not.toContain("<body>");
  });

  test("strips script and style tags from html", async () => {
    const html = `<html>
      <head><style>body { color: red; }</style></head>
      <body>
        <script>alert('xss')</script>
        <p>Visible</p>
      </body>
    </html>`;
    mockFetch(html, { contentType: "text/html" });
    const result = await webFetch({ url: "https://example.com" });
    expect(result).toContain("Visible");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("color: red");
  });

  test("decodes &nbsp; and &amp; entities", async () => {
    mockFetch("<p>foo&nbsp;bar&amp;baz</p>", { contentType: "text/html" });
    const result = await webFetch({ url: "https://example.com" });
    expect(result).toContain("foo bar&baz");
  });

  test("does not strip tags for non-html content types", async () => {
    mockFetch("<not-html>content</not-html>", {
      contentType: "application/json",
    });
    const result = await webFetch({ url: "https://example.com/api" });
    expect(result).toContain("<not-html>");
  });

  // ---------------------------------------------------------------------------
  // Truncation
  // ---------------------------------------------------------------------------

  test("truncates content exceeding max_length", async () => {
    const longText = "x".repeat(1000);
    mockFetch(longText);
    const result = await webFetch({ url: "https://example.com", max_length: 100 });
    expect(result).toContain("[... truncated at 100 characters]");
    expect(result.length).toBeLessThan(longText.length);
  });

  test("does not truncate content under max_length", async () => {
    mockFetch("short content");
    const result = await webFetch({ url: "https://example.com", max_length: 1000 });
    expect(result).toBe("short content");
    expect(result).not.toContain("truncated");
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  test("returns timeout error on AbortError", async () => {
    globalThis.fetch = mock(() => {
      const err = new DOMException("The operation was aborted", "AbortError");
      return Promise.reject(err);
    }) as any;
    const result = await webFetch({ url: "https://example.com/slow" });
    expect(result).toBe("Error: Request timed out (30s)");
  });

  test("returns error message on network failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Network unreachable")),
    ) as any;
    const result = await webFetch({ url: "https://example.com/down" });
    expect(result).toContain("Error fetching");
    expect(result).toContain("Network unreachable");
  });
});
