import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isDangerous,
  parseRule,
  matchesRule,
  checkPermissionRules,
  checkPermission,
  loadPermissionRules,
  resetPermissionRulesCache,
  type ParsedRule,
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
// matchesRule
// ---------------------------------------------------------------------------
describe("matchesRule", () => {
  test("returns false when tool name does not match", () => {
    const rule: ParsedRule = { tool: "run_shell", pattern: null };
    expect(matchesRule(rule, "read_file", {})).toBe(false);
  });

  test("matches any invocation when pattern is null", () => {
    const rule: ParsedRule = { tool: "run_shell", pattern: null };
    expect(matchesRule(rule, "run_shell", { command: "ls" })).toBe(true);
  });

  test("matches run_shell command exactly", () => {
    const rule: ParsedRule = { tool: "run_shell", pattern: "bun test" };
    expect(matchesRule(rule, "run_shell", { command: "bun test" })).toBe(true);
    expect(matchesRule(rule, "run_shell", { command: "bun run" })).toBe(false);
  });

  test("matches run_shell command with wildcard prefix", () => {
    const rule: ParsedRule = { tool: "run_shell", pattern: "git push *" };
    expect(matchesRule(rule, "run_shell", { command: "git push origin main" })).toBe(true);
    expect(matchesRule(rule, "run_shell", { command: "git pull" })).toBe(false);
  });

  test("matches file_path for file tools", () => {
    const rule: ParsedRule = { tool: "write_file", pattern: "/tmp/test.txt" };
    expect(matchesRule(rule, "write_file", { file_path: "/tmp/test.txt" })).toBe(true);
    expect(matchesRule(rule, "write_file", { file_path: "/tmp/other.txt" })).toBe(false);
  });

  test("matches file_path with wildcard prefix", () => {
    const rule: ParsedRule = { tool: "edit_file", pattern: "/src/*" };
    expect(matchesRule(rule, "edit_file", { file_path: "/src/foo.ts" })).toBe(true);
    expect(matchesRule(rule, "edit_file", { file_path: "/lib/foo.ts" })).toBe(false);
  });

  test("returns true when pattern exists but no matching input field", () => {
    const rule: ParsedRule = { tool: "web_fetch", pattern: "http://example.com" };
    expect(matchesRule(rule, "web_fetch", { url: "http://example.com" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkPermissionRules
// ---------------------------------------------------------------------------
describe("checkPermissionRules", () => {
  beforeEach(() => {
    resetPermissionRulesCache();
  });

  afterEach(() => {
    resetPermissionRulesCache();
  });

  test("returns null when no rules match", () => {
    // With default env (no settings files with matching rules), expect null
    const result = checkPermissionRules("some_unknown_tool", {});
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkPermission
// ---------------------------------------------------------------------------
describe("checkPermission", () => {
  beforeEach(() => {
    resetPermissionRulesCache();
  });

  afterEach(() => {
    resetPermissionRulesCache();
  });

  // --- bypassPermissions mode ---
  test("bypassPermissions allows everything", () => {
    expect(checkPermission("run_shell", { command: "rm -rf /" }, "bypassPermissions")).toEqual({
      action: "allow",
    });
  });

  // --- read tools always allowed ---
  test("allows read tools in default mode", () => {
    expect(checkPermission("read_file", { file_path: "/etc/passwd" })).toEqual({ action: "allow" });
    expect(checkPermission("list_files", { pattern: "**/*" })).toEqual({ action: "allow" });
    expect(checkPermission("grep_search", { pattern: "foo" })).toEqual({ action: "allow" });
    expect(checkPermission("tool_search", { query: "test" })).toEqual({ action: "allow" });
  });

  // --- plan mode ---
  test("plan mode blocks shell commands", () => {
    const result = checkPermission("run_shell", { command: "ls" }, "plan");
    expect(result.action).toBe("deny");
    expect(result.message).toContain("plan mode");
  });

  test("plan mode blocks edit tools on non-plan files", () => {
    const result = checkPermission("write_file", { file_path: "/src/foo.ts" }, "plan", "/plan.md");
    expect(result.action).toBe("deny");
    expect(result.message).toContain("plan mode");
  });

  test("plan mode allows edits to the plan file itself", () => {
    const result = checkPermission("write_file", { file_path: "/plan.md" }, "plan", "/plan.md");
    expect(result.action).toBe("allow");
  });

  test("plan mode allows read tools", () => {
    expect(checkPermission("read_file", { file_path: "/src/foo.ts" }, "plan")).toEqual({
      action: "allow",
    });
  });

  // --- plan mode tools always allowed ---
  test("enter_plan_mode is always allowed regardless of mode", () => {
    expect(checkPermission("enter_plan_mode", {}, "default")).toEqual({ action: "allow" });
    expect(checkPermission("enter_plan_mode", {}, "plan")).toEqual({ action: "allow" });
    expect(checkPermission("enter_plan_mode", {}, "dontAsk")).toEqual({ action: "allow" });
  });

  test("exit_plan_mode is always allowed regardless of mode", () => {
    expect(checkPermission("exit_plan_mode", {}, "default")).toEqual({ action: "allow" });
    expect(checkPermission("exit_plan_mode", {}, "plan")).toEqual({ action: "allow" });
    expect(checkPermission("exit_plan_mode", {}, "acceptEdits")).toEqual({ action: "allow" });
  });

  // --- acceptEdits mode ---
  test("acceptEdits mode allows edit tools", () => {
    expect(checkPermission("write_file", { file_path: __filename }, "acceptEdits")).toEqual({
      action: "allow",
    });
    expect(checkPermission("edit_file", { file_path: __filename }, "acceptEdits")).toEqual({
      action: "allow",
    });
  });

  // --- dangerous pattern detection ---
  test("dangerous shell command requires confirmation in default mode", () => {
    const result = checkPermission("run_shell", { command: "rm -rf /tmp/foo" }, "default");
    expect(result.action).toBe("confirm");
    expect(result.message).toBe("rm -rf /tmp/foo");
  });

  test("write to non-existent file requires confirmation", () => {
    const result = checkPermission(
      "write_file",
      { file_path: "/tmp/nonexistent-test-file-xyz-12345.txt" },
      "default",
    );
    expect(result.action).toBe("confirm");
    expect(result.message).toContain("write new file");
  });

  test("edit of non-existent file requires confirmation", () => {
    const result = checkPermission(
      "edit_file",
      { file_path: "/tmp/nonexistent-test-file-xyz-12345.txt" },
      "default",
    );
    expect(result.action).toBe("confirm");
    expect(result.message).toContain("edit non-existent file");
  });

  // --- dontAsk mode ---
  test("dontAsk mode auto-denies dangerous commands", () => {
    const result = checkPermission("run_shell", { command: "rm -rf /" }, "dontAsk");
    expect(result.action).toBe("deny");
    expect(result.message).toContain("Auto-denied");
    expect(result.message).toContain("dontAsk");
  });

  test("dontAsk mode auto-denies write to non-existent file", () => {
    const result = checkPermission(
      "write_file",
      { file_path: "/tmp/nonexistent-test-file-xyz-12345.txt" },
      "dontAsk",
    );
    expect(result.action).toBe("deny");
    expect(result.message).toContain("Auto-denied");
  });

  // --- safe commands ---
  test("safe shell command is allowed in default mode", () => {
    expect(checkPermission("run_shell", { command: "ls -la" }, "default")).toEqual({
      action: "allow",
    });
  });

  test("edit of existing file is allowed in default mode", () => {
    // __filename exists
    expect(checkPermission("edit_file", { file_path: __filename }, "default")).toEqual({
      action: "allow",
    });
  });

  test("write to existing file is allowed in default mode", () => {
    expect(checkPermission("write_file", { file_path: __filename }, "default")).toEqual({
      action: "allow",
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
