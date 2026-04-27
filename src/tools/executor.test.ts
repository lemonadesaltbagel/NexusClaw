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
    expect(result).toContain("[Truncated");
    teardown();
  });

  test("does not truncate results under 50K chars", async () => {
    setup();
    const filePath = join(TEST_DIR, "small.txt");
    writeFileSync(filePath, "small content");

    const result = await executeTool("read_file", { file_path: filePath });
    expect(result).not.toContain("[Truncated");
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
