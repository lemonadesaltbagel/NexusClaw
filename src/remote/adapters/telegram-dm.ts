// ---------------------------------------------------------------------------
// DM access control for the Telegram adapter — pure helpers.
//
// Four policies share a single mechanism: which telegramUserIds are allowed?
//   disable   → nobody
//   open      → everyone (first-time sender auto-added to userMap)
//   allowlist → only userMap entries (strangers silently dropped)
//   pairing   → only userMap entries; strangers get a code + prompt
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";

export type DmPolicyKind = "disable" | "open" | "allowlist" | "pairing";

export interface DmContext {
  policy: DmPolicyKind;
  /** Whether userId is already in the userMap (allowed). */
  isKnown:   (userId: string) => boolean;
  /** Whether userId has a pending pairing request (under "pairing" policy). */
  isPending: (userId: string) => boolean;
}

export type DmDecision =
  | { kind: "allow" }
  /** Auto-add to userMap, then allow. Only fired by "open" policy. */
  | { kind: "allow_and_register" }
  | { kind: "drop"; reason: string }
  /** Reply with the pairing prompt; drop the message. */
  | { kind: "pair_prompt"; reuseCode: boolean };

export function checkDmAccess(userId: string, ctx: DmContext): DmDecision {
  if (ctx.policy === "disable") return { kind: "drop", reason: "dm disabled" };

  if (ctx.isKnown(userId)) return { kind: "allow" };

  // Stranger (not in userMap).
  if (ctx.policy === "open")      return { kind: "allow_and_register" };
  if (ctx.policy === "allowlist") return { kind: "drop", reason: "not in allowlist" };

  // policy === "pairing"
  return { kind: "pair_prompt", reuseCode: ctx.isPending(userId) };
}

// ---------------------------------------------------------------------------
// Pairing code — 8 characters, uppercase, alphabet avoids 0/O/1/I/L to keep
// copy-pasted codes unambiguous in different fonts.
// ---------------------------------------------------------------------------

const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
  }
  return out;
}

/** True iff the string looks like one of our pairing codes. */
export function isPairingCodeShape(s: string): boolean {
  if (s.length !== PAIRING_CODE_LENGTH) return false;
  for (const c of s) if (!PAIRING_ALPHABET.includes(c)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Render the pairing prompt — kept here so the Telegram adapter holds no
// product copy of its own.
// ---------------------------------------------------------------------------

export function formatPairingPrompt(userId: string, code: string): string {
  return [
    `Your Telegram user id: ${userId}`,
    ``,
    `Pairing code:`,
    ``,
    `    ${code}`,
    ``,
    `Ask the bot owner to approve with:`,
    `nexusclaw pairing approve telegram ${code}`,
  ].join("\n");
}
