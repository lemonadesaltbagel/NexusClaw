import { test, expect, describe } from "bun:test";
import { isRetryable, withRetry } from "@/core/retry";

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe("isRetryable", () => {
  test("returns true for HTTP 429", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
  });

  test("returns true for HTTP 503", () => {
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  test("returns true for HTTP 529", () => {
    expect(isRetryable({ statusCode: 529 })).toBe(true);
  });

  test("returns true for ECONNRESET", () => {
    expect(isRetryable({ code: "ECONNRESET" })).toBe(true);
  });

  test("returns true for ETIMEDOUT", () => {
    expect(isRetryable({ code: "ETIMEDOUT" })).toBe(true);
  });

  test("returns true for overloaded message", () => {
    expect(isRetryable({ message: "server is overloaded" })).toBe(true);
  });

  test("returns false for HTTP 400", () => {
    expect(isRetryable({ status: 400 })).toBe(false);
  });

  test("returns false for generic error", () => {
    expect(isRetryable(new Error("something broke"))).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  test("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  test("retries on retryable error and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      if (calls < 3) throw { status: 429 };
      return Promise.resolve("recovered");
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("calls onRetry callback with correct arguments", async () => {
    const retries: Array<{ attempt: number; max: number; reason: string }> = [];
    let calls = 0;

    await withRetry(
      () => {
        calls++;
        if (calls === 1) throw { status: 503 };
        return Promise.resolve("ok");
      },
      undefined,
      3,
      (attempt, max, reason) => retries.push({ attempt, max, reason }),
    );

    expect(retries).toHaveLength(1);
    expect(retries[0]).toEqual({ attempt: 1, max: 3, reason: "HTTP 503" });
  });

  test("reports network error code as reason", async () => {
    const reasons: string[] = [];
    let calls = 0;

    await withRetry(
      () => {
        calls++;
        if (calls === 1) throw { code: "ECONNRESET" };
        return Promise.resolve("ok");
      },
      undefined,
      3,
      (_a, _m, reason) => reasons.push(reason),
    );

    expect(reasons[0]).toBe("ECONNRESET");
  });

  test("reports 'network error' when no status or code", async () => {
    const reasons: string[] = [];
    let calls = 0;

    await withRetry(
      () => {
        calls++;
        if (calls === 1) throw { message: "overloaded" };
        return Promise.resolve("ok");
      },
      undefined,
      3,
      (_a, _m, reason) => reasons.push(reason),
    );

    expect(reasons[0]).toBe("network error");
  });

  test("throws immediately for non-retryable error", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        throw new Error("bad request");
      }),
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  test("throws after exhausting maxRetries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          throw { status: 429, message: "rate limited" };
        },
        undefined,
        2,
      ),
    ).rejects.toHaveProperty("status", 429);
    // 1 initial + 2 retries = 3 calls
    expect(calls).toBe(3);
  });

  test("respects custom maxRetries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          throw { status: 503 };
        },
        undefined,
        1,
      ),
    ).rejects.toHaveProperty("status", 503);
    expect(calls).toBe(2);
  });

  test("throws immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          throw { status: 429 };
        },
        controller.signal,
      ),
    ).rejects.toHaveProperty("status", 429);
    expect(calls).toBe(1);
  });

  test("passes signal to the wrapped function", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    await withRetry((signal) => {
      receivedSignal = signal;
      return Promise.resolve("ok");
    }, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// withRetry — agent integration (retryable errors in provider)
// ---------------------------------------------------------------------------

describe("withRetry agent integration", () => {
  test("retryable provider error is retried before reaching agent error handling", async () => {
    // This verifies that withRetry sits between agent and provider,
    // handling transient errors before the agent's own PTL/recovery logic
    const { Agent } = await import("@/core/agent");
    const { makeMessage, sequenceProvider } = await (async () => {
      // Inline helpers matching agent.test.ts patterns
      function makeMessage(
        overrides: Partial<import("@/core/types").Message> & { stop_reason: import("@/core/types").Message["stop_reason"] },
      ): import("@/core/types").Message {
        return {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250514",
          content: overrides.content ?? [{ type: "text", text: "Hello" }],
          stop_reason: overrides.stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
          ...overrides,
        };
      }
      return { makeMessage, sequenceProvider: null };
    })();

    let callCount = 0;
    const retries: string[] = [];
    const provider = {
      createMessage: async () => {
        callCount++;
        if (callCount === 1) throw { status: 429, message: "rate limited" };
        return makeMessage({ stop_reason: "end_turn" });
      },
    };

    const agent = new Agent({
      provider,
      onRetry: (_a: number, _m: number, reason: string) => retries.push(reason),
    });

    const result = await agent.chat("Hello");
    expect(result.response.stop_reason).toBe("end_turn");
    expect(callCount).toBe(2);
    expect(retries).toEqual(["HTTP 429"]);
  });
});
