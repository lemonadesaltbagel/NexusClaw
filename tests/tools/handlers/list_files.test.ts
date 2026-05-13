import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { listFiles } from "@/tools/handlers/list_files";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `nexuscode-listfiles-test-${Date.now()}`);

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("listFiles", () => {
  beforeEach(() => setup());
  afterAll(() => teardown());

  test("lists files matching a glob pattern", async () => {
    writeFileSync(join(TEST_DIR, "a.ts"), "");
    writeFileSync(join(TEST_DIR, "b.ts"), "");
    writeFileSync(join(TEST_DIR, "c.js"), "");

    const result = await listFiles({ pattern: "*.ts", path: TEST_DIR });
    const files = result.split("\n").sort();
    expect(files).toEqual(["a.ts", "b.ts"]);
  });

  test("returns empty message when nothing matches", async () => {
    writeFileSync(join(TEST_DIR, "only.txt"), "");

    const result = await listFiles({ pattern: "*.nonexistent", path: TEST_DIR });
    expect(result).toBe("No files found matching the pattern.");
  });

  test("matches recursively with **", async () => {
    const sub = join(TEST_DIR, "deep", "nested");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "buried.md"), "");
    writeFileSync(join(TEST_DIR, "top.md"), "");

    const result = await listFiles({ pattern: "**/*.md", path: TEST_DIR });
    const files = result.split("\n").sort();
    expect(files).toContain("top.md");
    expect(files.some((f) => f.endsWith("buried.md"))).toBe(true);
  });

  test("skips node_modules entries", async () => {
    const nm = join(TEST_DIR, "node_modules", "pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "ignored.ts"), "");
    writeFileSync(join(TEST_DIR, "kept.ts"), "");

    const result = await listFiles({ pattern: "**/*.ts", path: TEST_DIR });
    expect(result).toContain("kept.ts");
    expect(result).not.toContain("node_modules");
  });

  test("skips .git entries", async () => {
    const git = join(TEST_DIR, ".git", "objects");
    mkdirSync(git, { recursive: true });
    writeFileSync(join(git, "pack.ts"), "");
    writeFileSync(join(TEST_DIR, "kept2.ts"), "");

    const result = await listFiles({ pattern: "**/*.ts", path: TEST_DIR });
    expect(result).toContain("kept2.ts");
    expect(result).not.toContain(".git");
  });

  test("does not include directories", async () => {
    mkdirSync(join(TEST_DIR, "subdir"), { recursive: true });
    writeFileSync(join(TEST_DIR, "file.txt"), "");

    const result = await listFiles({ pattern: "*", path: TEST_DIR });
    const lines = result.split("\n");
    expect(lines).toContain("file.txt");
    expect(lines).not.toContain("subdir");
  });

  test("caps results at 200 files", async () => {
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(TEST_DIR, `f${i}.dat`), "");
    }
    const result = await listFiles({ pattern: "*.dat", path: TEST_DIR });
    const lines = result.split("\n");
    expect(lines.length).toBe(200);
  });

  test("defaults path to current directory when omitted", async () => {
    const result = await listFiles({ pattern: "*.nonexistent-xyz" });
    expect(result).toBe("No files found matching the pattern.");
  });
});
