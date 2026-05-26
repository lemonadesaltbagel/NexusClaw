import { test, expect, describe } from "bun:test";
import {
  classifyChat,
  isSelfMessage,
  checkGroupAccess,
  type AccessSettings,
  type ChatSpace,
} from "@/remote/adapters/telegram-access";

// ---------------------------------------------------------------------------
// classifyChat
// ---------------------------------------------------------------------------

describe("classifyChat", () => {
  test("private chat → dm", () => {
    expect(classifyChat({ id: 1, type: "private" }, {})).toEqual({ kind: "dm" });
  });

  test("channel → channel (out of scope)", () => {
    expect(classifyChat({ id: 1, type: "channel" }, {})).toEqual({ kind: "channel" });
  });

  test("group → group with stringified chatId", () => {
    expect(classifyChat({ id: -100, type: "group" }, {})).toEqual({
      kind: "group", chatId: "-100",
    });
  });

  test("supergroup without thread → group", () => {
    expect(classifyChat({ id: -1001, type: "supergroup" }, {})).toEqual({
      kind: "group", chatId: "-1001",
    });
  });

  test("supergroup with is_topic_message + thread → forum", () => {
    expect(classifyChat(
      { id: -1001, type: "supergroup" },
      { is_topic_message: true, message_thread_id: 7 },
    )).toEqual({ kind: "forum", chatId: "-1001", topicId: "7" });
  });

  test("supergroup with thread but no is_topic_message → still group", () => {
    expect(classifyChat(
      { id: -1001, type: "supergroup" },
      { message_thread_id: 7 },
    )).toEqual({ kind: "group", chatId: "-1001" });
  });
});

// ---------------------------------------------------------------------------
// isSelfMessage
// ---------------------------------------------------------------------------

describe("isSelfMessage", () => {
  test("matches when fromId equals botId", () => {
    expect(isSelfMessage(42, 42)).toBe(true);
  });
  test("does not match for other senders", () => {
    expect(isSelfMessage(99, 42)).toBe(false);
  });
  test("undefined sender is not self", () => {
    expect(isSelfMessage(undefined, 42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkGroupAccess
// ---------------------------------------------------------------------------

const dm: ChatSpace = { kind: "dm" };
const channel: ChatSpace = { kind: "channel" };
const group = (id = "-100"): ChatSpace => ({ kind: "group", chatId: id });
const forum = (chatId = "-100", topicId = "7"): ChatSpace => ({ kind: "forum", chatId, topicId });

describe("checkGroupAccess — special spaces", () => {
  test("dm always allowed (gate is downstream)", () => {
    expect(checkGroupAccess(dm, "any", {})).toEqual({ allowed: true });
  });
  test("channel always denied", () => {
    const r = checkGroupAccess(channel, "any", {});
    expect(r.allowed).toBe(false);
  });
});

describe("checkGroupAccess — groups", () => {
  test("unconfigured group → denied", () => {
    const r = checkGroupAccess(group(), "42", {});
    expect(r).toEqual({ allowed: false, reason: "group not configured" });
  });

  test("policy=disabled → denied", () => {
    const s: AccessSettings = { groups: { "-100": { policy: "disabled" } } };
    expect(checkGroupAccess(group(), "42", s)).toEqual({
      allowed: false, reason: "group disabled",
    });
  });

  test("policy=open → anyone allowed", () => {
    const s: AccessSettings = { groups: { "-100": { policy: "open" } } };
    expect(checkGroupAccess(group(), "42", s)).toEqual({ allowed: true });
    expect(checkGroupAccess(group(), "99", s)).toEqual({ allowed: true });
  });

  test("policy=allowlist → only listed users allowed", () => {
    const s: AccessSettings = {
      groups: { "-100": { policy: "allowlist", allowedUsers: ["42"] } },
    };
    expect(checkGroupAccess(group(), "42", s)).toEqual({ allowed: true });
    const denied = checkGroupAccess(group(), "99", s);
    expect(denied.allowed).toBe(false);
  });

  test("policy=allowlist with no allowedUsers → everyone denied", () => {
    const s: AccessSettings = {
      groups: { "-100": { policy: "allowlist" } },
    };
    expect(checkGroupAccess(group(), "42", s).allowed).toBe(false);
  });
});

describe("checkGroupAccess — forums", () => {
  test("topic not configured → denied (even with policy=open)", () => {
    const s: AccessSettings = { groups: { "-100": { policy: "open" } } };
    expect(checkGroupAccess(forum(), "42", s)).toEqual({
      allowed: false, reason: "topic not configured",
    });
  });

  test("topic disabled → denied", () => {
    const s: AccessSettings = {
      groups: { "-100": { policy: "open", topics: { "7": { enabled: false } } } },
    };
    expect(checkGroupAccess(forum(), "42", s)).toEqual({
      allowed: false, reason: "topic disabled",
    });
  });

  test("topic enabled + policy=open → allowed", () => {
    const s: AccessSettings = {
      groups: { "-100": { policy: "open", topics: { "7": { enabled: true } } } },
    };
    expect(checkGroupAccess(forum(), "42", s)).toEqual({ allowed: true });
  });

  test("topic enabled + policy=allowlist + user listed → allowed", () => {
    const s: AccessSettings = {
      groups: {
        "-100": {
          policy: "allowlist",
          allowedUsers: ["42"],
          topics: { "7": { enabled: true } },
        },
      },
    };
    expect(checkGroupAccess(forum(), "42", s)).toEqual({ allowed: true });
  });

  test("topic enabled + policy=allowlist + user NOT listed → denied", () => {
    const s: AccessSettings = {
      groups: {
        "-100": {
          policy: "allowlist",
          allowedUsers: ["42"],
          topics: { "7": { enabled: true } },
        },
      },
    };
    expect(checkGroupAccess(forum(), "99", s).allowed).toBe(false);
  });

  test("topic enabled + group disabled → still denied", () => {
    const s: AccessSettings = {
      groups: {
        "-100": { policy: "disabled", topics: { "7": { enabled: true } } },
      },
    };
    expect(checkGroupAccess(forum(), "42", s).allowed).toBe(false);
  });
});
