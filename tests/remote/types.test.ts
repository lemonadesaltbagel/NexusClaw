import { test, expect, describe } from "bun:test";
import { identityKey, type RemoteIdentity } from "@/remote/types";

describe("identityKey", () => {
  test("encodes platform, userId, and chatId", () => {
    const id: RemoteIdentity = { platform: "telegram", userId: "42", chatId: "100" };
    expect(identityKey(id)).toBe("telegram:42:100");
  });

  test("same identity yields the same key (stable)", () => {
    const a: RemoteIdentity = { platform: "slack", userId: "U1", chatId: "C1" };
    const b: RemoteIdentity = { platform: "slack", userId: "U1", chatId: "C1" };
    expect(identityKey(a)).toBe(identityKey(b));
  });

  test("different userId or chatId yield different keys", () => {
    const base: RemoteIdentity = { platform: "telegram", userId: "1", chatId: "1" };
    expect(identityKey(base)).not.toBe(identityKey({ ...base, userId: "2" }));
    expect(identityKey(base)).not.toBe(identityKey({ ...base, chatId: "2" }));
    expect(identityKey(base)).not.toBe(identityKey({ ...base, platform: "slack" }));
  });
});
