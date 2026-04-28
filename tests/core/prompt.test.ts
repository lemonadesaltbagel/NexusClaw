import { test, expect, describe } from "bun:test";
import { resolveIncludes } from "@/core/prompt";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `nexuscode-include-test-${Date.now()}`);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("resolveIncludes", () => {
  test("returns content unchanged when no @include directives", () => {
    const content = "# Hello\nSome text\nNo includes here.";
    expect(resolveIncludes(content, "/tmp")).toBe(content);
  });

  test("resolves a relative ./path include", () => {
    setup();
    const included = "included content";
    writeFileSync(join(TEST_DIR, "extra.md"), included);

    const content = `before\n@./extra.md\nafter`;
    const result = resolveIncludes(content, TEST_DIR);
    expect(result).toBe(`before\n${included}\nafter`);
    teardown();
  });

  test("resolves an absolute path include", () => {
    setup();
    const included = "absolute included";
    const filePath = join(TEST_DIR, "abs.md");
    writeFileSync(filePath, included);

    const content = `start\n@${filePath}\nend`;
    const result = resolveIncludes(content, "/somewhere/else");
    expect(result).toBe(`start\n${included}\nend`);
    teardown();
  });

  test("resolves ~/path includes", () => {
    // This test creates a temp file in a subdir and manually passes basePath,
    // but the ~/ resolution uses os.homedir(). We test by creating a file
    // under homedir if possible, or just verify the path resolution logic.
    // Since writing to homedir in tests is invasive, we test that a missing
    // ~/path produces the not-found comment.
    const content = `@~/nonexistent-nexuscode-test-file-12345.md`;
    const result = resolveIncludes(content, "/tmp");
    expect(result).toContain("<!-- not found: ~/nonexistent-nexuscode-test-file-12345.md -->");
  });

  test("replaces missing file with not-found comment", () => {
    const content = `@./does-not-exist.md`;
    const result = resolveIncludes(content, "/tmp");
    expect(result).toBe("<!-- not found: ./does-not-exist.md -->");
  });

  test("detects circular includes", () => {
    setup();
    const fileA = join(TEST_DIR, "a.md");
    const fileB = join(TEST_DIR, "b.md");
    writeFileSync(fileA, `@./b.md`);
    writeFileSync(fileB, `@./a.md`);

    const content = `@./a.md`;
    const result = resolveIncludes(content, TEST_DIR);
    // a.md includes b.md, b.md tries to include a.md which is already visited
    expect(result).toContain("<!-- circular: ./a.md -->");
    teardown();
  });

  test("resolves nested includes recursively", () => {
    setup();
    writeFileSync(join(TEST_DIR, "level1.md"), "L1 @./level2.md");
    writeFileSync(join(TEST_DIR, "level2.md"), "L2 @./level3.md");
    writeFileSync(join(TEST_DIR, "level3.md"), "L3");

    // Note: @include must be on its own line, so adjust content
    writeFileSync(join(TEST_DIR, "level1.md"), "L1\n@./level2.md");
    writeFileSync(join(TEST_DIR, "level2.md"), "L2\n@./level3.md");

    const content = `@./level1.md`;
    const result = resolveIncludes(content, TEST_DIR);
    expect(result).toContain("L1");
    expect(result).toContain("L2");
    expect(result).toContain("L3");
    teardown();
  });

  test("stops resolving at MAX_INCLUDE_DEPTH", () => {
    setup();
    // Create a chain of 6 files, each including the next
    for (let i = 0; i < 6; i++) {
      const next = i < 5 ? `\n@./d${i + 1}.md` : "";
      writeFileSync(join(TEST_DIR, `d${i}.md`), `depth${i}${next}`);
    }

    const content = `@./d0.md`;
    // depth=0 resolves d0, depth=1 resolves d1, ..., depth=4 resolves d4
    // depth=5 hits MAX_INCLUDE_DEPTH=5, so d5's @include (if any) stays raw
    const result = resolveIncludes(content, TEST_DIR);
    expect(result).toContain("depth0");
    expect(result).toContain("depth4");
    // At depth=5 (MAX_INCLUDE_DEPTH), the @./d5.md directive is left unresolved
    expect(result).toContain("@./d5.md");
    expect(result).not.toContain("depth5");
    teardown();
  });

  test("handles multiple includes in the same content", () => {
    setup();
    writeFileSync(join(TEST_DIR, "one.md"), "first");
    writeFileSync(join(TEST_DIR, "two.md"), "second");

    const content = `header\n@./one.md\nmiddle\n@./two.md\nfooter`;
    const result = resolveIncludes(content, TEST_DIR);
    expect(result).toBe("header\nfirst\nmiddle\nsecond\nfooter");
    teardown();
  });

  test("does not resolve @include that is not on its own line", () => {
    setup();
    writeFileSync(join(TEST_DIR, "x.md"), "should not appear");

    // Inline @./x.md should NOT be resolved (not at start of line by itself)
    const content = `some text @./x.md more text`;
    const result = resolveIncludes(content, TEST_DIR);
    expect(result).toBe(content);
    teardown();
  });

  test("resolves includes in subdirectories relative to included file", () => {
    setup();
    const subDir = join(TEST_DIR, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(TEST_DIR, "parent.md"), "P\n@./sub/child.md");
    writeFileSync(join(subDir, "child.md"), "C\n@./grandchild.md");
    writeFileSync(join(subDir, "grandchild.md"), "GC");

    const content = `@./parent.md`;
    const result = resolveIncludes(content, TEST_DIR);
    expect(result).toContain("P");
    expect(result).toContain("C");
    expect(result).toContain("GC");
    teardown();
  });
});
