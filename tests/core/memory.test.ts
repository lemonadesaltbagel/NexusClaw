import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import * as os from "os";
import {
  parseFrontmatter,
  formatFrontmatter,
  saveMemory,
  listMemories,
  getMemory,
  deleteMemory,
  getMemoryDir,
  buildMemoryPromptSection,
  loadMemoryIndex,
} from "../../src/core/memory.js";

// ---------------------------------------------------------------------------
// Frontmatter parsing / formatting
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  test("parses valid frontmatter", () => {
    const input = `---
name: test memory
description: a test
type: user
---

Some body content here.`;

    const result = parseFrontmatter(input);
    expect(result.meta).toEqual({
      name: "test memory",
      description: "a test",
      type: "user",
    });
    expect(result.body).toBe("Some body content here.");
  });

  test("returns raw content when no frontmatter", () => {
    const input = "Just plain text.";
    const result = parseFrontmatter(input);
    expect(result.meta).toEqual({});
    expect(result.body).toBe(input);
  });

  test("handles missing closing delimiter", () => {
    const input = `---
name: broken
no closing delimiter`;
    const result = parseFrontmatter(input);
    expect(result.meta).toEqual({});
    expect(result.body).toBe(input);
  });

  test("handles colons in values", () => {
    const input = `---
url: https://example.com:8080/path
---

body`;
    const result = parseFrontmatter(input);
    expect(result.meta.url).toBe("https://example.com:8080/path");
  });
});

describe("formatFrontmatter", () => {
  test("produces valid frontmatter string", () => {
    const result = formatFrontmatter(
      { name: "test", type: "user" },
      "body content"
    );
    expect(result).toContain("---\nname: test\ntype: user\n---");
    expect(result).toContain("body content");
  });

  test("roundtrips with parseFrontmatter", () => {
    const meta = { name: "roundtrip", description: "test", type: "feedback" };
    const body = "Some content.";
    const formatted = formatFrontmatter(meta, body);
    const parsed = parseFrontmatter(formatted);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// CRUD operations (use a temp directory as cwd to isolate)
// ---------------------------------------------------------------------------

describe("memory CRUD", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "nexus-memory-test-"));
  });

  afterEach(() => {
    // Clean up the memory dir created under ~/.nexus/projects/
    const memDir = getMemoryDir(tmpDir);
    try { rmSync(memDir, { recursive: true, force: true }); } catch {}
    // Also try to clean parent dirs if empty
    try { rmSync(join(memDir, ".."), { recursive: true, force: true }); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("saveMemory creates file and index", () => {
    const filename = saveMemory(
      {
        name: "user role",
        description: "User is a backend engineer",
        type: "user",
        content: "The user is a senior backend engineer focused on Go.",
      },
      tmpDir
    );

    expect(filename).toBe("user_user_role.md");

    const memDir = getMemoryDir(tmpDir);
    expect(existsSync(join(memDir, filename))).toBe(true);
    expect(existsSync(join(memDir, "MEMORY.md"))).toBe(true);

    const index = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
    expect(index).toContain("user role");
  });

  test("listMemories returns saved entries", () => {
    saveMemory(
      { name: "pref A", description: "desc A", type: "user", content: "A" },
      tmpDir
    );
    saveMemory(
      { name: "pref B", description: "desc B", type: "feedback", content: "B" },
      tmpDir
    );

    const memories = listMemories(tmpDir);
    expect(memories).toHaveLength(2);
    expect(memories.map((m) => m.name).sort()).toEqual(["pref A", "pref B"]);
  });

  test("getMemory retrieves a specific entry", () => {
    const filename = saveMemory(
      { name: "ci url", description: "CI dashboard", type: "reference", content: "https://ci.example.com" },
      tmpDir
    );

    const entry = getMemory(filename, tmpDir);
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("ci url");
    expect(entry!.type).toBe("reference");
    expect(entry!.content).toBe("https://ci.example.com");
  });

  test("getMemory returns null for missing file", () => {
    expect(getMemory("nonexistent.md", tmpDir)).toBeNull();
  });

  test("deleteMemory removes file and updates index", () => {
    const filename = saveMemory(
      { name: "temp", description: "temporary", type: "project", content: "x" },
      tmpDir
    );

    expect(deleteMemory(filename, tmpDir)).toBe(true);

    const memDir = getMemoryDir(tmpDir);
    expect(existsSync(join(memDir, filename))).toBe(false);

    const index = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
    expect(index).not.toContain("temp");
  });

  test("deleteMemory returns false for missing file", () => {
    expect(deleteMemory("nope.md", tmpDir)).toBe(false);
  });

  test("saveMemory overwrites existing entry with same name/type", () => {
    saveMemory(
      { name: "role", description: "v1", type: "user", content: "version 1" },
      tmpDir
    );
    saveMemory(
      { name: "role", description: "v2", type: "user", content: "version 2" },
      tmpDir
    );

    const memories = listMemories(tmpDir);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe("version 2");
    expect(memories[0].description).toBe("v2");
  });
});

// ---------------------------------------------------------------------------
// Prompt section builder
// ---------------------------------------------------------------------------

describe("buildMemoryPromptSection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "nexus-memory-prompt-"));
  });

  afterEach(() => {
    const memDir = getMemoryDir(tmpDir);
    try { rmSync(memDir, { recursive: true, force: true }); } catch {}
    try { rmSync(join(memDir, ".."), { recursive: true, force: true }); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("always returns memory system instructions", () => {
    const section = buildMemoryPromptSection(tmpDir);
    expect(section).toContain("# Memory System");
    expect(section).toContain("Memory Types");
    expect(section).toContain("How to Save Memories");
    expect(section).toContain("(No memories saved yet.)");
  });

  test("includes memory index when memories exist", () => {
    saveMemory(
      { name: "user role", description: "role info", type: "user", content: "Senior engineer" },
      tmpDir
    );
    saveMemory(
      { name: "no mocks", description: "testing rule", type: "feedback", content: "Use real DB in tests" },
      tmpDir
    );

    const section = buildMemoryPromptSection(tmpDir);
    expect(section).toContain("# Memory System");
    expect(section).toContain("## Current Memory Index");
    expect(section).toContain("user role");
    expect(section).toContain("no mocks");
    expect(section).not.toContain("(No memories saved yet.)");
  });
});

// ---------------------------------------------------------------------------
// Index truncation
// ---------------------------------------------------------------------------

describe("loadMemoryIndex", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "nexus-memory-index-"));
  });

  afterEach(() => {
    const memDir = getMemoryDir(tmpDir);
    try { rmSync(memDir, { recursive: true, force: true }); } catch {}
    try { rmSync(join(memDir, ".."), { recursive: true, force: true }); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("returns empty string when no index exists", () => {
    expect(loadMemoryIndex(tmpDir)).toBe("");
  });

  test("returns full index for small memory sets", () => {
    saveMemory(
      { name: "small", description: "small entry", type: "user", content: "x" },
      tmpDir
    );

    const index = loadMemoryIndex(tmpDir);
    expect(index).toContain("small");
    expect(index).not.toContain("truncated");
  });

  test("truncates index beyond 200 lines", () => {
    // Create enough memories to exceed 200 lines in the index
    for (let i = 0; i < 210; i++) {
      saveMemory(
        { name: `mem ${i}`, description: `desc ${i}`, type: "user", content: `content ${i}` },
        tmpDir
      );
    }

    const index = loadMemoryIndex(tmpDir);
    const lines = index.split("\n");
    // Should be truncated: 200 original lines + blank + truncation message
    expect(lines.length).toBeLessThan(210 + 5); // well under full count
    expect(index).toContain("[... truncated, too many memory entries ...]");
  });

  test("truncates index beyond 25KB", () => {
    // Create memories with very long descriptions to exceed byte limit
    const longDesc = "x".repeat(500);
    for (let i = 0; i < 60; i++) {
      saveMemory(
        { name: `big entry ${i}`, description: longDesc, type: "feedback", content: `c${i}` },
        tmpDir
      );
    }

    const index = loadMemoryIndex(tmpDir);
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(25_000 + 200); // small overhead for truncation message
    expect(index).toContain("[... truncated");
  });
});
