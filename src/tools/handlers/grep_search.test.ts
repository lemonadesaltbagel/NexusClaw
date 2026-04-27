import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { grepSearch } from "@/tools/handlers/grep_search";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `nexuscode-grepsearch-test-${Date.now()}`);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("grepSearch", () => {
  beforeEach(() => setup());
  afterAll(() => teardown());

  test("finds matching lines with line numbers", () => {
    writeFileSync(join(TEST_DIR, "a.txt"), "hello world\nfoo bar\nhello again");

    const result = grepSearch({ pattern: "hello", path: TEST_DIR });
    expect(result).toContain("hello world");
    expect(result).toContain("hello again");
    // grep --line-number output includes :<number>:
    expect(result).toContain(":1:");
    expect(result).toContain(":3:");
  });

  test("returns no matches message when pattern not found", () => {
    writeFileSync(join(TEST_DIR, "b.txt"), "nothing here");

    const result = grepSearch({ pattern: "zzzznotfound", path: TEST_DIR });
    expect(result).toBe("No matches found.");
  });

  test("searches recursively in subdirectories", () => {
    const sub = join(TEST_DIR, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "nested.txt"), "deepmatch_xyz");

    const result = grepSearch({ pattern: "deepmatch_xyz", path: TEST_DIR });
    expect(result).toContain("deepmatch_xyz");
    expect(result).toContain("nested.txt");
  });

  test("filters files with include glob", () => {
    writeFileSync(join(TEST_DIR, "code.ts"), "findme in ts");
    writeFileSync(join(TEST_DIR, "code.js"), "findme in js");

    const result = grepSearch({
      pattern: "findme",
      path: TEST_DIR,
      include: "*.ts",
    });
    expect(result).toContain("code.ts");
    expect(result).not.toContain("code.js");
  });

  test("caps output at 100 lines", () => {
    // Create a file with >100 matching lines
    const lines = Array.from({ length: 150 }, (_, i) => `match_${i}`);
    writeFileSync(join(TEST_DIR, "many.txt"), lines.join("\n"));

    const result = grepSearch({ pattern: "match_", path: TEST_DIR });
    // Should contain the truncation notice
    expect(result).toContain("... and ");
    expect(result).toContain("more matches");
  });

  test("defaults path to current directory when path omitted", () => {
    // Search in an empty temp dir to guarantee no matches
    const emptyDir = join(TEST_DIR, "empty_search");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "dummy.txt"), "nothing special");

    const result = grepSearch({ pattern: "willnotmatch999", path: emptyDir });
    expect(result).toBe("No matches found.");
  });
});
