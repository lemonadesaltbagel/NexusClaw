import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
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
  scanMemoryHeaders,
  formatMemoryManifest,
  memoryAge,
  memoryFreshnessWarning,
  selectRelevantMemories,
  startMemoryPrefetch,
  formatMemoriesForInjection,
} from "../../src/core/memory.js";
import type { SideQueryFn, RelevantMemory } from "../../src/core/memory.js";

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

// ---------------------------------------------------------------------------
// Semantic recall helpers
// ---------------------------------------------------------------------------

describe("scanMemoryHeaders", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "nexus-memory-scan-"));
  });

  afterEach(() => {
    const memDir = getMemoryDir(tmpDir);
    try { rmSync(memDir, { recursive: true, force: true }); } catch {}
    try { rmSync(join(memDir, ".."), { recursive: true, force: true }); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("returns empty array when no memories", () => {
    expect(scanMemoryHeaders(tmpDir)).toEqual([]);
  });

  test("returns headers with mtime for saved memories", () => {
    saveMemory(
      { name: "role", description: "user role", type: "user", content: "engineer" },
      tmpDir
    );
    const headers = scanMemoryHeaders(tmpDir);
    expect(headers).toHaveLength(1);
    expect(headers[0].name).toBe("role");
    expect(headers[0].type).toBe("user");
    expect(headers[0].filename).toBe("user_role.md");
    expect(headers[0].mtimeMs).toBeGreaterThan(0);
    expect(headers[0].filePath).toContain("user_role.md");
  });
});

describe("formatMemoryManifest", () => {
  test("formats headers into manifest lines", () => {
    const headers = [
      { filename: "user_role.md", filePath: "/tmp/user_role.md", name: "role", description: "user role", type: "user" as const, mtimeMs: 1000 },
      { filename: "feedback_no_mocks.md", filePath: "/tmp/feedback_no_mocks.md", name: "no mocks", description: "testing", type: "feedback" as const, mtimeMs: 2000 },
    ];
    const manifest = formatMemoryManifest(headers);
    expect(manifest).toContain("user_role.md: [user] role — user role");
    expect(manifest).toContain("feedback_no_mocks.md: [feedback] no mocks — testing");
  });
});

describe("memoryAge", () => {
  test("returns 'today' for recent timestamps", () => {
    expect(memoryAge(Date.now() - 1000)).toBe("today");
  });

  test("returns 'yesterday' for 1 day old", () => {
    expect(memoryAge(Date.now() - 1000 * 60 * 60 * 24 - 1000)).toBe("yesterday");
  });

  test("returns days for under 30 days", () => {
    expect(memoryAge(Date.now() - 1000 * 60 * 60 * 24 * 10)).toBe("10 days ago");
  });

  test("returns months for over 30 days", () => {
    expect(memoryAge(Date.now() - 1000 * 60 * 60 * 24 * 60)).toBe("2 months ago");
  });
});

describe("memoryFreshnessWarning", () => {
  test("returns empty for fresh memories", () => {
    expect(memoryFreshnessWarning(Date.now())).toBe("");
  });

  test("warns for memories over 30 days old", () => {
    const warning = memoryFreshnessWarning(Date.now() - 1000 * 60 * 60 * 24 * 45);
    expect(warning).toContain("over 1 month old");
  });

  test("warns more strongly for memories over 90 days old", () => {
    const warning = memoryFreshnessWarning(Date.now() - 1000 * 60 * 60 * 24 * 100);
    expect(warning).toContain("over 3 months old");
  });
});

// ---------------------------------------------------------------------------
// selectRelevantMemories
// ---------------------------------------------------------------------------

describe("selectRelevantMemories", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "nexus-memory-select-"));
  });

  afterEach(() => {
    const memDir = getMemoryDir(tmpDir);
    try { rmSync(memDir, { recursive: true, force: true }); } catch {}
    try { rmSync(join(memDir, ".."), { recursive: true, force: true }); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("returns empty when no memories exist", async () => {
    const sideQuery: SideQueryFn = async () => '{"selected_memories": []}';
    const result = await selectRelevantMemories("test query", sideQuery, new Set(), undefined, tmpDir);
    expect(result).toEqual([]);
  });

  test("selects memories based on sideQuery response", async () => {
    saveMemory(
      { name: "db config", description: "database setup", type: "reference", content: "Use postgres on port 5432" },
      tmpDir
    );
    saveMemory(
      { name: "user role", description: "role info", type: "user", content: "Senior engineer" },
      tmpDir
    );

    const sideQuery: SideQueryFn = async () =>
      '{"selected_memories": ["reference_db_config.md"]}';

    const result = await selectRelevantMemories("database question", sideQuery, new Set(), undefined, tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("postgres on port 5432");
    expect(result[0].header).toContain("Memory");
  });

  test("skips already-surfaced memories", async () => {
    saveMemory(
      { name: "surfaced", description: "already shown", type: "user", content: "old" },
      tmpDir
    );

    const memDir = getMemoryDir(tmpDir);
    const surfacedPath = join(memDir, "user_surfaced.md");
    const alreadySurfaced = new Set([surfacedPath]);

    const sideQuery: SideQueryFn = async () =>
      '{"selected_memories": ["user_surfaced.md"]}';

    const result = await selectRelevantMemories("query", sideQuery, alreadySurfaced, undefined, tmpDir);
    expect(result).toEqual([]);
  });

  test("handles sideQuery failure gracefully", async () => {
    saveMemory(
      { name: "test", description: "test", type: "user", content: "x" },
      tmpDir
    );

    const sideQuery: SideQueryFn = async () => { throw new Error("API error"); };

    const result = await selectRelevantMemories("query", sideQuery, new Set(), undefined, tmpDir);
    expect(result).toEqual([]);
  });

  test("handles malformed JSON from sideQuery", async () => {
    saveMemory(
      { name: "test", description: "test", type: "user", content: "x" },
      tmpDir
    );

    const sideQuery: SideQueryFn = async () => "not json at all";

    const result = await selectRelevantMemories("query", sideQuery, new Set(), undefined, tmpDir);
    expect(result).toEqual([]);
  });

  test("handles JSON wrapped in markdown code blocks", async () => {
    saveMemory(
      { name: "wrapped", description: "test", type: "feedback", content: "content here" },
      tmpDir
    );

    const sideQuery: SideQueryFn = async () =>
      '```json\n{"selected_memories": ["feedback_wrapped.md"]}\n```';

    const result = await selectRelevantMemories("query", sideQuery, new Set(), undefined, tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("content here");
  });

  test("truncates large memory files to 4KB", async () => {
    const largeContent = "x".repeat(8000);
    saveMemory(
      { name: "big", description: "large file", type: "project", content: largeContent },
      tmpDir
    );

    const sideQuery: SideQueryFn = async () =>
      '{"selected_memories": ["project_big.md"]}';

    const result = await selectRelevantMemories("query", sideQuery, new Set(), undefined, tmpDir);
    expect(result).toHaveLength(1);
    expect(Buffer.byteLength(result[0].content)).toBeLessThanOrEqual(4096 + 100);
    expect(result[0].content).toContain("[... truncated");
  });

  test("limits selection to 5 memories", async () => {
    for (let i = 0; i < 8; i++) {
      saveMemory(
        { name: `mem ${i}`, description: `desc ${i}`, type: "user", content: `content ${i}` },
        tmpDir
      );
    }

    const sideQuery: SideQueryFn = async () =>
      JSON.stringify({
        selected_memories: Array.from({ length: 8 }, (_, i) => `user_mem_${i}.md`),
      });

    const result = await selectRelevantMemories("query", sideQuery, new Set(), undefined, tmpDir);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Async prefetch
// ---------------------------------------------------------------------------

describe("startMemoryPrefetch", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "nexus-memory-prefetch-"));
  });

  afterEach(() => {
    const memDir = getMemoryDir(tmpDir);
    try { rmSync(memDir, { recursive: true, force: true }); } catch {}
    try { rmSync(join(memDir, ".."), { recursive: true, force: true }); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const mockSideQuery: SideQueryFn = async () => '{"selected_memories": []}';

  test("returns null for single-word queries", () => {
    saveMemory({ name: "test", description: "t", type: "user", content: "x" }, tmpDir);
    const result = startMemoryPrefetch("hello", mockSideQuery, new Set(), 0, undefined, tmpDir);
    expect(result).toBeNull();
  });

  test("returns null when session budget exceeded", () => {
    saveMemory({ name: "test", description: "t", type: "user", content: "x" }, tmpDir);
    const result = startMemoryPrefetch("hello world", mockSideQuery, new Set(), 60_000, undefined, tmpDir);
    expect(result).toBeNull();
  });

  test("returns null when no memory files exist", () => {
    const result = startMemoryPrefetch("hello world", mockSideQuery, new Set(), 0, undefined, tmpDir);
    expect(result).toBeNull();
  });

  test("returns prefetch handle for valid multi-word query with memories", () => {
    saveMemory({ name: "test", description: "t", type: "user", content: "x" }, tmpDir);
    const handle = startMemoryPrefetch("hello world", mockSideQuery, new Set(), 0, undefined, tmpDir);
    expect(handle).not.toBeNull();
    expect(handle!.settled).toBe(false);
    expect(handle!.consumed).toBe(false);
  });

  test("prefetch settles asynchronously", async () => {
    saveMemory({ name: "test", description: "t", type: "user", content: "x" }, tmpDir);
    const handle = startMemoryPrefetch("hello world", mockSideQuery, new Set(), 0, undefined, tmpDir);
    expect(handle).not.toBeNull();

    await handle!.promise;
    // settled flag is set via .then(), may need a microtask tick
    await new Promise((r) => setTimeout(r, 0));
    expect(handle!.settled).toBe(true);
  });

  test("prefetch settles on error too", async () => {
    saveMemory({ name: "test", description: "t", type: "user", content: "x" }, tmpDir);
    const failingSideQuery: SideQueryFn = async () => { throw new Error("fail"); };
    const handle = startMemoryPrefetch("hello world", failingSideQuery, new Set(), 0, undefined, tmpDir);
    expect(handle).not.toBeNull();

    await handle!.promise;
    await new Promise((r) => setTimeout(r, 0));
    expect(handle!.settled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatMemoriesForInjection
// ---------------------------------------------------------------------------

describe("formatMemoriesForInjection", () => {
  test("wraps memories in system-reminder tags", () => {
    const memories: RelevantMemory[] = [
      { path: "/tmp/a.md", content: "content A", mtimeMs: 1000, header: "Memory: /tmp/a.md:" },
      { path: "/tmp/b.md", content: "content B", mtimeMs: 2000, header: "Memory: /tmp/b.md:" },
    ];

    const result = formatMemoriesForInjection(memories);
    expect(result).toContain("<system-reminder>");
    expect(result).toContain("</system-reminder>");
    expect(result).toContain("content A");
    expect(result).toContain("content B");
    expect(result).toContain("Memory: /tmp/a.md:");
  });

  test("returns empty string for empty array", () => {
    expect(formatMemoriesForInjection([])).toBe("");
  });
});
