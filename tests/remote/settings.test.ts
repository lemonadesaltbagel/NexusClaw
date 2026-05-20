import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettings,
  buildIdentityResolver,
  type NexusClawSettings,
} from "@/remote/settings";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nexusclaw-settings-"));
  configPath = join(tmpDir, "nexusclaw.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSettings", () => {
  test("returns null when the file does not exist", () => {
    expect(loadSettings(join(tmpDir, "missing.json"))).toBeNull();
  });

  test("parses a minimal config with no remote block", () => {
    writeFileSync(configPath, JSON.stringify({}));
    const s = loadSettings(configPath);
    expect(s).toEqual({ remote: {} });
  });

  test("parses a telegram block with userMap", () => {
    writeFileSync(configPath, JSON.stringify({
      remote: { telegram: { token: "abc:123", userMap: { "42": "xintian" } } },
    }));
    const s = loadSettings(configPath);
    expect(s?.remote.telegram).toEqual({ token: "abc:123", userMap: { "42": "xintian" } });
  });

  test("defaults userMap to {} when omitted", () => {
    writeFileSync(configPath, JSON.stringify({
      remote: { telegram: { token: "abc:123" } },
    }));
    const s = loadSettings(configPath);
    expect(s?.remote.telegram?.userMap).toEqual({});
  });

  test("throws on missing telegram token", () => {
    writeFileSync(configPath, JSON.stringify({ remote: { telegram: { userMap: {} } } }));
    expect(() => loadSettings(configPath)).toThrow();
  });

  test("throws on invalid JSON", () => {
    writeFileSync(configPath, "{ not json");
    expect(() => loadSettings(configPath)).toThrow();
  });
});

describe("buildIdentityResolver", () => {
  function settingsWithMap(map: Record<string, string>): NexusClawSettings {
    return { remote: { telegram: { token: "t", userMap: map } } };
  }

  test("denies everything when settings is null", () => {
    const r = buildIdentityResolver(null);
    expect(r({ platform: "telegram", userId: "1", chatId: "1" })).toBeNull();
  });

  test("denies when no telegram block is present", () => {
    const r = buildIdentityResolver({ remote: {} });
    expect(r({ platform: "telegram", userId: "1", chatId: "1" })).toBeNull();
  });

  test("maps known telegram users to their canonical id", () => {
    const r = buildIdentityResolver(settingsWithMap({ "42": "xintian", "99": "alice" }));
    expect(r({ platform: "telegram", userId: "42", chatId: "x" })).toBe("xintian");
    expect(r({ platform: "telegram", userId: "99", chatId: "y" })).toBe("alice");
  });

  test("denies unknown telegram users", () => {
    const r = buildIdentityResolver(settingsWithMap({ "42": "xintian" }));
    expect(r({ platform: "telegram", userId: "99", chatId: "x" })).toBeNull();
  });

  test("denies platforms that are not configured", () => {
    const r = buildIdentityResolver(settingsWithMap({ "42": "xintian" }));
    expect(r({ platform: "slack", userId: "42", chatId: "x" })).toBeNull();
  });
});
