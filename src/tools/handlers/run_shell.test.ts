import { test, expect, describe } from "bun:test";
import { runShell } from "@/tools/handlers/run_shell";

describe("runShell", () => {
  test("executes command and returns stdout", () => {
    const result = runShell({ command: "echo hello" });
    expect(result.trim()).toBe("hello");
  });

  test("returns (no output) for silent commands", () => {
    const result = runShell({ command: "true" });
    expect(result).toBe("(no output)");
  });

  test("returns error info for failing commands", () => {
    const result = runShell({ command: "false" });
    expect(result).toContain("Command failed");
    expect(result).toContain("exit code");
  });

  test("captures stderr on failure", () => {
    const result = runShell({ command: "echo oops >&2 && exit 1" });
    expect(result).toContain("Command failed");
    expect(result).toContain("Stderr: oops");
  });

  test("respects custom timeout", () => {
    const result = runShell({ command: "sleep 5", timeout: 100 });
    expect(result).toContain("Command failed");
  });

  test("handles multi-line output", () => {
    const result = runShell({ command: "printf 'line1\\nline2\\nline3'" });
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line3");
  });

  test("captures stdout from partially-failed commands", () => {
    const result = runShell({
      command: "echo partial && exit 1",
    });
    expect(result).toContain("Command failed");
    expect(result).toContain("Stdout: partial");
  });
});
