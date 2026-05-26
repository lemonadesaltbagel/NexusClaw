import { test, expect, describe } from "bun:test";
import {
  checkDmAccess,
  generatePairingCode,
  isPairingCodeShape,
  formatPairingPrompt,
  PAIRING_CODE_LENGTH,
} from "@/remote/adapters/telegram-dm";

// ---------------------------------------------------------------------------
// checkDmAccess
// ---------------------------------------------------------------------------

function ctx(policy: "disable" | "open" | "allowlist" | "pairing", opts: {
  known?: string[]; pending?: string[];
} = {}) {
  const known = new Set(opts.known ?? []);
  const pending = new Set(opts.pending ?? []);
  return {
    policy,
    isKnown:   (id: string) => known.has(id),
    isPending: (id: string) => pending.has(id),
  };
}

describe("checkDmAccess", () => {
  test("disable → drop, no matter who", () => {
    expect(checkDmAccess("42", ctx("disable")).kind).toBe("drop");
    expect(checkDmAccess("42", ctx("disable", { known: ["42"] })).kind).toBe("drop");
  });

  test("open + known → allow", () => {
    expect(checkDmAccess("42", ctx("open", { known: ["42"] }))).toEqual({ kind: "allow" });
  });

  test("open + stranger → allow_and_register", () => {
    expect(checkDmAccess("99", ctx("open"))).toEqual({ kind: "allow_and_register" });
  });

  test("allowlist + known → allow", () => {
    expect(checkDmAccess("42", ctx("allowlist", { known: ["42"] }))).toEqual({ kind: "allow" });
  });

  test("allowlist + stranger → drop with reason", () => {
    expect(checkDmAccess("99", ctx("allowlist"))).toEqual({
      kind: "drop", reason: "not in allowlist",
    });
  });

  test("pairing + known → allow", () => {
    expect(checkDmAccess("42", ctx("pairing", { known: ["42"] }))).toEqual({ kind: "allow" });
  });

  test("pairing + stranger (no pending) → pair_prompt with reuseCode=false", () => {
    expect(checkDmAccess("99", ctx("pairing"))).toEqual({
      kind: "pair_prompt", reuseCode: false,
    });
  });

  test("pairing + stranger (already pending) → pair_prompt with reuseCode=true", () => {
    expect(checkDmAccess("99", ctx("pairing", { pending: ["99"] }))).toEqual({
      kind: "pair_prompt", reuseCode: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Pairing code
// ---------------------------------------------------------------------------

describe("generatePairingCode", () => {
  test("returns a code of the configured length", () => {
    expect(generatePairingCode().length).toBe(PAIRING_CODE_LENGTH);
  });

  test("uses only the safe alphabet (no 0/O/1/I/L)", () => {
    const FORBIDDEN = /[0OIL1]/;
    for (let i = 0; i < 100; i++) {
      expect(generatePairingCode()).not.toMatch(FORBIDDEN);
    }
  });

  test("two consecutive codes are very likely different", () => {
    expect(generatePairingCode()).not.toBe(generatePairingCode());
  });
});

describe("isPairingCodeShape", () => {
  test("accepts a freshly-generated code", () => {
    expect(isPairingCodeShape(generatePairingCode())).toBe(true);
  });
  test("rejects wrong length", () => {
    expect(isPairingCodeShape("ABCD")).toBe(false);
  });
  test("rejects forbidden characters", () => {
    expect(isPairingCodeShape("ABCD0123")).toBe(false); // "0" forbidden
    expect(isPairingCodeShape("ABCDIIII")).toBe(false); // "I" forbidden
  });
});

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

describe("formatPairingPrompt", () => {
  test("includes the userId, the code, and the approve instruction", () => {
    const prompt = formatPairingPrompt("555111222", "ABCD1234");
    expect(prompt).toContain("Your Telegram user id: 555111222");
    expect(prompt).toContain("ABCD1234");
    expect(prompt).toContain("nexusclaw pairing approve telegram ABCD1234");
  });
});
