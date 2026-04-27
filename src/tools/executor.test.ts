import { test, expect, describe } from "bun:test";
import { executeTool } from "@/tools/executor";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers — temp directory for file-based tests
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `nexuscode-executor-test-${Date.now()}`);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 1. Dispatcher routing
// ---------------------------------------------------------------------------

describe("executeTool routing", () => {
  test("routes read_file to readFile handler", async () => {
    setup();
    const filePath = join(TEST_DIR, "hello.txt");
    writeFileSync(filePath, "hello world");

    const result = await executeTool("read_file", { file_path: filePath });
    expect(result).toContain("hello world");
    expect(result).toContain("1 |"); // line-numbered output
    teardown();
  });

  test("routes grep_search to grepSearch handler", async () => {
    setup();
    const filePath = join(TEST_DIR, "searchme.txt");
    writeFileSync(filePath, "findthis line\nother line");

    const result = await executeTool("grep_search", {
      pattern: "findthis",
      path: TEST_DIR,
    });
    expect(result).toContain("findthis line");
    teardown();
  });

  test("routes run_shell to runShell handler", async () => {
    const result = await executeTool("run_shell", { command: "echo routed" });
    expect(result.trim()).toBe("routed");
  });

  test("returns unknown tool message for unregistered names", async () => {
    const result = await executeTool("nonexistent_tool", {});
    expect(result).toContain("Unknown tool");
    expect(result).toContain("nonexistent_tool");
  });
});

// ---------------------------------------------------------------------------
// 2. Result truncation
// ---------------------------------------------------------------------------

describe("executeTool truncation", () => {
  test("truncates results exceeding 50K chars", async () => {
    setup();
    const filePath = join(TEST_DIR, "large.txt");
    // Create a file with content that will exceed 50K when line-numbered
    const bigContent = "x".repeat(60_000);
    writeFileSync(filePath, bigContent);

    const result = await executeTool("read_file", { file_path: filePath });
    expect(result.length).toBeLessThanOrEqual(60_000); // truncated
    expect(result).toContain("[... truncated");
    teardown();
  });

  test("preserves both head and tail when truncating", async () => {
    setup();
    const filePath = join(TEST_DIR, "headtail.txt");
    const head = "HEAD_MARKER_" + "a".repeat(100);
    const tail = "b".repeat(100) + "_TAIL_MARKER";
    // head + middle + tail exceeds 50K when line-numbered
    const bigContent = head + "x".repeat(60_000) + tail;
    writeFileSync(filePath, bigContent);

    const result = await executeTool("read_file", { file_path: filePath });
    expect(result).toContain("[... truncated");
    expect(result).toContain("HEAD_MARKER_");
    expect(result).toContain("_TAIL_MARKER");
    teardown();
  });

  test("does not truncate results under 50K chars", async () => {
    setup();
    const filePath = join(TEST_DIR, "small.txt");
    writeFileSync(filePath, "small content");

    const result = await executeTool("read_file", { file_path: filePath });
    expect(result).not.toContain("[... truncated");
    teardown();
  });
});

// ---------------------------------------------------------------------------
// 3. Error propagation from handlers
// ---------------------------------------------------------------------------

describe("executeTool error handling", () => {
  test("propagates errors from stub handlers as thrown exceptions", async () => {
    // write_file is a stub that throws "not implemented"
    await expect(
      executeTool("write_file", { file_path: "/tmp/x", content: "y" }),
    ).rejects.toThrow("not implemented");
  });
});
