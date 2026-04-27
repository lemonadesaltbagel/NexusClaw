import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { editFile } from "@/tools/handlers/edit_file";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `nexuscode-editfile-test-${Date.now()}`);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("editFile", () => {
  beforeEach(() => setup());
  afterAll(() => teardown());

  test("replaces exact string match and writes file", () => {
    const filePath = join(TEST_DIR, "basic.txt");
    writeFileSync(filePath, "hello world\ngoodbye world\n");

    const result = editFile({
      file_path: filePath,
      old_string: "hello world",
      new_string: "hi world",
    });

    expect(result).toContain("Successfully edited");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("hi world\ngoodbye world\n");
  });

  test("returns diff with line numbers", () => {
    const filePath = join(TEST_DIR, "diff.txt");
    writeFileSync(filePath, "aaa\nbbb\nccc\n");

    const result = editFile({
      file_path: filePath,
      old_string: "bbb",
      new_string: "BBB",
    });

    expect(result).toContain("@@");
    expect(result).toContain("- bbb");
    expect(result).toContain("+ BBB");
  });

  test("errors when old_string not found", () => {
    const filePath = join(TEST_DIR, "notfound.txt");
    writeFileSync(filePath, "hello world\n");

    const result = editFile({
      file_path: filePath,
      old_string: "nonexistent",
      new_string: "replacement",
    });

    expect(result).toContain("Error: old_string not found");
  });

  test("errors when old_string matches multiple times", () => {
    const filePath = join(TEST_DIR, "dupes.txt");
    writeFileSync(filePath, "foo bar\nfoo baz\n");

    const result = editFile({
      file_path: filePath,
      old_string: "foo",
      new_string: "qux",
    });

    expect(result).toContain("found 2 times");
    expect(result).toContain("Must be unique");

    // File should not be modified
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("foo bar\nfoo baz\n");
  });

  test("handles quote normalization (curly quotes → straight)", () => {
    const filePath = join(TEST_DIR, "quotes.txt");
    // File has straight quotes
    writeFileSync(filePath, 'say "hello"\n');

    // Search with curly quotes (Unicode)
    const result = editFile({
      file_path: filePath,
      old_string: 'say \u201Chello\u201D',
      new_string: 'say "hi"',
    });

    expect(result).toContain("Successfully edited");
    expect(result).toContain("quote normalization");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe('say "hi"\n');
  });

  test("handles multi-line replacements", () => {
    const filePath = join(TEST_DIR, "multiline.txt");
    writeFileSync(filePath, "line1\nline2\nline3\nline4\n");

    const result = editFile({
      file_path: filePath,
      old_string: "line2\nline3",
      new_string: "new2\nnew3\nnew3b",
    });

    expect(result).toContain("Successfully edited");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("line1\nnew2\nnew3\nnew3b\nline4\n");
  });

  test("errors for non-existent file", () => {
    const result = editFile({
      file_path: join(TEST_DIR, "ghost.txt"),
      old_string: "x",
      new_string: "y",
    });

    expect(result).toContain("Error editing file:");
  });

  test("handles replacement that removes content (empty new_string)", () => {
    const filePath = join(TEST_DIR, "remove.txt");
    writeFileSync(filePath, "keep this\nremove this\nkeep this too\n");

    const result = editFile({
      file_path: filePath,
      old_string: "remove this\n",
      new_string: "",
    });

    expect(result).toContain("Successfully edited");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("keep this\nkeep this too\n");
  });
});
