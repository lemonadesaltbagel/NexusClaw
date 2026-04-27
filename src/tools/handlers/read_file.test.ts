import { test, expect, describe } from "bun:test";
import { readFile } from "@/tools/handlers/read_file";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `nexuscode-readfile-test-${Date.now()}`);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("readFile", () => {
  test("returns file content with 1-based line numbers", () => {
    setup();
    const filePath = join(TEST_DIR, "sample.txt");
    writeFileSync(filePath, "line one\nline two\nline three");

    const result = readFile({ file_path: filePath });
    expect(result).toContain("1 | line one");
    expect(result).toContain("2 | line two");
    expect(result).toContain("3 | line three");
    teardown();
  });

  test("pads line numbers for alignment", () => {
    setup();
    const filePath = join(TEST_DIR, "padded.txt");
    // Create a file with >9 lines to check padding
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    writeFileSync(filePath, lines.join("\n"));

    const result = readFile({ file_path: filePath });
    // Line 1 should be padded to match width of line 12
    expect(result).toContain("   1 | line 1");
    expect(result).toContain("  12 | line 12");
    teardown();
  });

  test("handles empty files", () => {
    setup();
    const filePath = join(TEST_DIR, "empty.txt");
    writeFileSync(filePath, "");

    const result = readFile({ file_path: filePath });
    // Empty file has one empty line
    expect(result).toContain("1 |");
    teardown();
  });

  test("returns error message for non-existent file", () => {
    const result = readFile({ file_path: "/nonexistent/path/file.txt" });
    expect(result).toContain("Error reading file:");
  });

  test("handles single-line files", () => {
    setup();
    const filePath = join(TEST_DIR, "single.txt");
    writeFileSync(filePath, "only line");

    const result = readFile({ file_path: filePath });
    expect(result).toContain("1 | only line");
    // Should not have line 2
    expect(result).not.toContain("2 |");
    teardown();
  });
});
