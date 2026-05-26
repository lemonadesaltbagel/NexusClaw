import { test, expect, describe } from "bun:test";
import { truncateForLog } from "@/remote/adapters/telegram-verbose";

describe("truncateForLog", () => {
  test("primitives are returned unchanged", () => {
    expect(truncateForLog(42)).toBe(42);
    expect(truncateForLog(true)).toBe(true);
    expect(truncateForLog(null)).toBe(null);
    expect(truncateForLog(undefined)).toBe(undefined);
  });

  test("short strings are unchanged", () => {
    expect(truncateForLog("hello")).toBe("hello");
  });

  test("strings exceeding maxStringLen are truncated with a count suffix", () => {
    const big = "x".repeat(600);
    const out = truncateForLog(big) as string;
    expect(out.startsWith("x".repeat(500))).toBe(true);
    expect(out).toContain("… (100 more chars)");
  });

  test("custom maxStringLen is respected", () => {
    const out = truncateForLog("abcdef", { maxStringLen: 3 }) as string;
    expect(out).toBe("abc… (3 more chars)");
  });

  test("short arrays are recursively walked, unchanged in length", () => {
    expect(truncateForLog([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("arrays exceeding maxArrayLen are sliced with a tail marker", () => {
    const arr = Array.from({ length: 25 }, (_, i) => i);
    const out = truncateForLog(arr) as unknown[];
    expect(out.length).toBe(21); // 20 items + tail marker
    expect(out.slice(0, 20)).toEqual(arr.slice(0, 20));
    expect(out[20]).toBe("[+5 more]");
  });

  test("custom maxArrayLen is respected", () => {
    const arr = [1, 2, 3, 4, 5];
    expect(truncateForLog(arr, { maxArrayLen: 2 })).toEqual([1, 2, "[+3 more]"]);
  });

  test("nested objects are walked, primitives preserved", () => {
    const update = {
      update_id: 99,
      message: {
        text: "hello",
        from: { id: 42, username: "alice" },
      },
    };
    expect(truncateForLog(update)).toEqual(update);
  });

  test("truncation applies inside nested fields", () => {
    const update = {
      update_id: 1,
      message: { text: "a".repeat(700) },
    };
    const out = truncateForLog(update) as { message: { text: string } };
    expect(out.message.text.length).toBeLessThan(700);
    expect(out.message.text).toContain("… (200 more chars)");
  });

  test("the input value is never mutated", () => {
    const input = { text: "x".repeat(600), items: Array.from({ length: 30 }, (_, i) => i) };
    const snapshot = { text: input.text, items: input.items.slice() };
    truncateForLog(input);
    expect(input.text).toBe(snapshot.text);
    expect(input.items).toEqual(snapshot.items);
  });

  test("circular references are short-circuited", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => truncateForLog(a)).not.toThrow();
    const out = truncateForLog(a) as Record<string, unknown>;
    expect(out.self).toBe("[Circular]");
  });
});
