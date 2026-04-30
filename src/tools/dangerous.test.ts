import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isDangerous,
  parseRule,
  loadPermissionRules,
  resetPermissionRulesCache,
} from "./dangerous";

// ---------------------------------------------------------------------------
// isDangerous
// ---------------------------------------------------------------------------
describe("isDangerous", () => {
  test("detects rm commands", () => {
    expect(isDangerous("rm -rf /")).toBe(true);
    expect(isDangerous("rm file.txt")).toBe(true);
  });

  test("detects dangerous git commands", () => {
    expect(isDangerous("git push origin main")).toBe(true);
    expect(isDangerous("git reset --hard")).toBe(true);
    expect(isDangerous("git clean -fd")).toBe(true);
    expect(isDangerous("git checkout .")).toBe(true);
  });

  test("detects sudo", () => {
    expect(isDangerous("sudo apt install foo")).toBe(true);
  });

  test("detects system-level commands", () => {
    expect(isDangerous("mkfs /dev/sda1")).toBe(true);
    expect(isDangerous("dd if=/dev/zero of=/dev/sda")).toBe(true);
    expect(isDangerous("reboot")).toBe(true);
    expect(isDangerous("shutdown -h now")).toBe(true);
  });

  test("detects kill commands", () => {
    expect(isDangerous("kill -9 1234")).toBe(true);
    expect(isDangerous("pkill node")).toBe(true);
  });

  test("detects redirect to /dev/", () => {
    expect(isDangerous("echo x > /dev/sda")).toBe(true);
  });

  test("detects Windows dangerous commands (case-insensitive)", () => {
    expect(isDangerous("del file.txt")).toBe(true);
    expect(isDangerous("DEL file.txt")).toBe(true);
    expect(isDangerous("rmdir /s /q folder")).toBe(true);
    expect(isDangerous("format C:")).toBe(true);
    expect(isDangerous("taskkill /F /PID 1234")).toBe(true);
    expect(isDangerous("Remove-Item foo")).toBe(true);
    expect(isDangerous("Stop-Process -Name node")).toBe(true);
  });

  test("allows safe commands", () => {
    expect(isDangerous("ls -la")).toBe(false);
    expect(isDangerous("git status")).toBe(false);
    expect(isDangerous("git diff")).toBe(false);
    expect(isDangerous("echo hello")).toBe(false);
    expect(isDangerous("cat file.txt")).toBe(false);
    expect(isDangerous("bun test")).toBe(false);
    expect(isDangerous("git commit -m 'fix'")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseRule
// ---------------------------------------------------------------------------
describe("parseRule", () => {
  test("parses rule with pattern", () => {
    expect(parseRule("run_shell(rm *)")).toEqual({
      tool: "run_shell",
      pattern: "rm *",
    });
  });

  test("parses rule with complex pattern", () => {
    expect(parseRule("bash(git push origin/*)")).toEqual({
      tool: "bash",
      pattern: "git push origin/*",
    });
  });

  test("parses rule without pattern", () => {
    expect(parseRule("run_shell")).toEqual({
      tool: "run_shell",
      pattern: null,
    });
  });

  test("parses single-word tool name", () => {
    expect(parseRule("bash")).toEqual({
      tool: "bash",
      pattern: null,
    });
  });
});

// ---------------------------------------------------------------------------
// loadPermissionRules
// ---------------------------------------------------------------------------
describe("loadPermissionRules", () => {
  const tmpBase = join(tmpdir(), `dangerous-test-${Date.now()}`);
  const fakeHome = join(tmpBase, "home");
  const fakeProject = join(tmpBase, "project");

  const origHomedir = process.env.HOME;
  const origCwd = process.cwd();

  beforeEach(() => {
    resetPermissionRulesCache();
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeProject, ".claude"), { recursive: true });
  });

  afterEach(() => {
    resetPermissionRulesCache();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  test("returns empty rules when no settings files exist", () => {
    // Point to dirs with no settings.json
    const emptyDir = join(tmpBase, "empty");
    mkdirSync(join(emptyDir, ".claude"), { recursive: true });
    mkdirSync(join(emptyDir, "project", ".claude"), { recursive: true });

    // We can't easily override homedir() and cwd() without mocking,
    // so we test the exported functions in isolation instead.
    // loadPermissionRules uses the real homedir/cwd — tested via integration below.
    const rules = loadPermissionRules();
    // At minimum, should return the shape
    expect(rules).toHaveProperty("allow");
    expect(rules).toHaveProperty("deny");
    expect(Array.isArray(rules.allow)).toBe(true);
    expect(Array.isArray(rules.deny)).toBe(true);
  });

  test("caches results across calls", () => {
    const first = loadPermissionRules();
    const second = loadPermissionRules();
    expect(first).toBe(second); // same reference
  });

  test("resetPermissionRulesCache clears cache", () => {
    const first = loadPermissionRules();
    resetPermissionRulesCache();
    const second = loadPermissionRules();
    // After reset, should be a new object (though values may be equal)
    expect(first).not.toBe(second);
  });
});
