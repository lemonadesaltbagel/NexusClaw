import { test, expect, describe, beforeEach } from "bun:test";
import { executeTool, readFileState } from "@/tools/executor";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers — temp directory for file-based tests
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `nexuscode-executor-test-${Date.now()}`);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
  readFileState.clear();
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

  test("routes web_fetch to webFetch handler", async () => {
    // Use a mock server via run_shell to avoid external requests
    const result = await executeTool("web_fetch", {
      url: "https://example.com",
    });
    // Should return some content (or an error if offline), but not "Unknown tool"
    expect(result).not.toContain("Unknown tool");
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
// 3. Read-before-write protection
// ---------------------------------------------------------------------------

describe("read-before-write protection", () => {
  beforeEach(() => {
    readFileState.clear();
  });

  test("write_file blocks if file exists but was never read", async () => {
    setup();
    const filePath = join(TEST_DIR, "unread.txt");
    writeFileSync(filePath, "original");

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "new",
    });
    expect(result).toContain("must read this file before writing");
    teardown();
  });

  test("edit_file blocks if file was never read", async () => {
    setup();
    const filePath = join(TEST_DIR, "unread2.txt");
    writeFileSync(filePath, "original");

    const result = await executeTool("edit_file", {
      file_path: filePath,
      old_string: "original",
      new_string: "changed",
    });
    expect(result).toContain("must read this file before editing");
    teardown();
  });

  test("write_file succeeds after read_file", async () => {
    setup();
    const filePath = join(TEST_DIR, "readfirst.txt");
    writeFileSync(filePath, "original");

    await executeTool("read_file", { file_path: filePath });
    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "updated",
    });
    expect(result).toContain("Successfully wrote");
    teardown();
  });

  test("edit_file succeeds after read_file", async () => {
    setup();
    const filePath = join(TEST_DIR, "editafter.txt");
    writeFileSync(filePath, "original content here");

    await executeTool("read_file", { file_path: filePath });
    const result = await executeTool("edit_file", {
      file_path: filePath,
      old_string: "original",
      new_string: "modified",
    });
    expect(result).toContain("Successfully edited");
    teardown();
  });

  test("write_file warns when file was externally modified", async () => {
    setup();
    const filePath = join(TEST_DIR, "external.txt");
    writeFileSync(filePath, "original");

    await executeTool("read_file", { file_path: filePath });

    // Simulate external modification by changing mtime
    const futureMs = Date.now() + 5000;
    const futureS = futureMs / 1000;
    const { utimesSync } = require("node:fs");
    utimesSync(filePath, futureS, futureS);

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "overwrite",
    });
    expect(result).toContain("modified externally");
    teardown();
  });

  test("write_file allows creating new files without prior read", async () => {
    setup();
    const filePath = join(TEST_DIR, "brand-new.txt");

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "fresh content",
    });
    expect(result).toContain("Successfully wrote");
    teardown();
  });
});
