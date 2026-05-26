import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let tmpDir: string;
let pairingPath: string;
let configPath: string;

const ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nexusclaw-pairing-cli-"));
  pairingPath = join(tmpDir, "pairing.json");
  configPath = join(tmpDir, "nexusclaw.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", ["run", ENTRY, "pairing", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ANTHROPIC_API_KEY: "dummy" },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("pairing list", () => {
  test("reports an empty state cleanly", () => {
    writeFileSync(pairingPath, JSON.stringify({ telegram: { pending: {} } }));
    const r = run(["list", "telegram", "--pairing-path", pairingPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No pending");
  });

  test("lists pending entries", () => {
    writeFileSync(pairingPath, JSON.stringify({
      telegram: { pending: {
        "42": { code: "ABCD1234", username: "alice", requestedAt: "2026-01-01T00:00:00Z" },
      } },
    }));
    const r = run(["list", "telegram", "--pairing-path", pairingPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ABCD1234");
    expect(r.stdout).toContain("42");
    expect(r.stdout).toContain("@alice");
  });

  test("rejects unknown platforms", () => {
    const r = run(["list", "slack", "--pairing-path", pairingPath]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Unknown platform");
  });
});

describe("pairing approve", () => {
  beforeEach(() => {
    writeFileSync(configPath, JSON.stringify({
      remote: { telegram: { token: "t", userMap: {} } },
    }));
    writeFileSync(pairingPath, JSON.stringify({
      telegram: { pending: {
        "42": { code: "ABCD1234", username: "alice", requestedAt: "2026-01-01T00:00:00Z" },
      } },
    }));
  });

  test("writes userMap entry, removes pending, prints confirmation", () => {
    const r = run([
      "approve", "telegram", "ABCD1234",
      "--pairing-path", pairingPath,
      "--config", configPath,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Approved");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.remote.telegram.userMap["42"]).toBe("alice");
    const pairing = JSON.parse(readFileSync(pairingPath, "utf-8"));
    expect(pairing.telegram.pending["42"]).toBeUndefined();
  });

  test("--as overrides the canonical id", () => {
    const r = run([
      "approve", "telegram", "ABCD1234",
      "--as", "xintian",
      "--pairing-path", pairingPath,
      "--config", configPath,
    ]);
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.remote.telegram.userMap["42"]).toBe("xintian");
  });

  test("falls back to tg_<userId> when no username", () => {
    writeFileSync(pairingPath, JSON.stringify({
      telegram: { pending: {
        "42": { code: "ABCD1234", requestedAt: "2026-01-01T00:00:00Z" },
      } },
    }));
    const r = run([
      "approve", "telegram", "ABCD1234",
      "--pairing-path", pairingPath,
      "--config", configPath,
    ]);
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.remote.telegram.userMap["42"]).toBe("tg_42");
  });

  test("fails clearly on an unknown code", () => {
    const r = run([
      "approve", "telegram", "BOGUS123",
      "--pairing-path", pairingPath,
      "--config", configPath,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("No pending request");
  });
});
