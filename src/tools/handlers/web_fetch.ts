// ---------------------------------------------------------------------------
// web_fetch — Fetch a URL and return its content as text.
// For HTML pages, script/style tags are stripped and HTML tags removed.
// ---------------------------------------------------------------------------

export async function webFetch(input: {
  url: string;
  max_length?: number;
}): Promise<string> {
  const { url } = input;
  const maxLength = input.max_length ?? 50_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "nexuscode/1.0" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return `HTTP error: ${res.status} ${res.statusText}`;
    }

    const contentType = res.headers.get("content-type") ?? "";
    let text = await res.text();

    if (contentType.includes("html")) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    if (text.length > maxLength) {
      text =
        text.slice(0, maxLength) +
        `\n\n[... truncated at ${maxLength} characters]`;
    }

    return text || "(empty response)";
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return "Error: Request timed out (30s)";
    }
    return `Error fetching ${url}: ${err.message}`;
  }
}
