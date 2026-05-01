// ---------------------------------------------------------------------------
// Memory system — persistent, file-based memory across conversations
// ---------------------------------------------------------------------------
// Storage layout:
//   ~/.nexus/projects/{sha256-hash}/memory/
//   ├── MEMORY.md                          # Index file
//   ├── user_prefers_concise_output.md
//   ├── feedback_no_summary_at_end.md
//   ├── project_auth_migration_q2.md
//   └── reference_ci_dashboard_url.md
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import * as os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface FrontmatterResult {
  meta: Record<string, string>;
  body: string;
}

export interface MemoryEntry {
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Derive the memory directory for the current working directory. */
export function getMemoryDir(cwd: string = process.cwd()): string {
  const hash = createHash("sha256").update(cwd).digest("hex");
  return join(os.homedir(), ".nexus", "projects", hash, "memory");
}

function getIndexPath(cwd?: string): string {
  return join(getMemoryDir(cwd), "MEMORY.md");
}

function ensureMemoryDir(cwd?: string): void {
  const dir = getMemoryDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parser / formatter (YAML-like)
// ---------------------------------------------------------------------------

export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const value = lines[i].slice(colonIdx + 1).trim();
    if (key) meta[key] = value;
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { meta, body };
}

export function formatFrontmatter(
  meta: Record<string, string>,
  body: string
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  lines.push(""); // trailing newline
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/** Save (create or overwrite) a memory entry. Returns the filename. */
export function saveMemory(entry: Omit<MemoryEntry, "filename">, cwd?: string): string {
  ensureMemoryDir(cwd);
  const dir = getMemoryDir(cwd);
  const filename = `${entry.type}_${slugify(entry.name)}.md`;
  const content = formatFrontmatter(
    { name: entry.name, description: entry.description, type: entry.type },
    entry.content
  );
  writeFileSync(join(dir, filename), content);
  updateMemoryIndex(cwd);
  return filename;
}

/** List all memory entries in the current project. */
export function listMemories(cwd?: string): MemoryEntry[] {
  const dir = getMemoryDir(cwd);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );

  const entries: MemoryEntry[] = [];
  for (const file of files.sort()) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      if (meta.name && meta.type) {
        entries.push({
          filename: file,
          name: meta.name,
          description: meta.description ?? "",
          type: meta.type as MemoryType,
          content: body,
        });
      }
    } catch {
      // skip malformed files
    }
  }
  return entries;
}

/** Get a single memory by filename. */
export function getMemory(filename: string, cwd?: string): MemoryEntry | null {
  const dir = getMemoryDir(cwd);
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) return null;

  try {
    const raw = readFileSync(filepath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    return {
      filename,
      name: meta.name ?? "",
      description: meta.description ?? "",
      type: (meta.type as MemoryType) ?? "user",
      content: body,
    };
  } catch {
    return null;
  }
}

/** Delete a memory by filename. Returns true if deleted. */
export function deleteMemory(filename: string, cwd?: string): boolean {
  const dir = getMemoryDir(cwd);
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) return false;

  try {
    unlinkSync(filepath);
    updateMemoryIndex(cwd);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Index truncation limits
// ---------------------------------------------------------------------------

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

/** Load and truncate the memory index to safe limits. */
export function loadMemoryIndex(cwd?: string): string {
  const indexPath = getIndexPath(cwd);
  if (!existsSync(indexPath)) return "";

  let content = readFileSync(indexPath, "utf-8");

  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = lines.slice(0, MAX_INDEX_LINES).join("\n") +
      "\n\n[... truncated, too many memory entries ...]";
  }
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
    content = content.slice(0, MAX_INDEX_BYTES) +
      "\n\n[... truncated, index too large ...]";
  }
  return content;
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

function updateMemoryIndex(cwd?: string): void {
  ensureMemoryDir(cwd);
  const memories = listMemories(cwd);
  const lines = ["# Memory Index", ""];
  for (const m of memories) {
    lines.push(`- **[${m.name}](${m.filename})** (${m.type}) — ${m.description}`);
  }
  writeFileSync(getIndexPath(cwd), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// System prompt integration
// ---------------------------------------------------------------------------

/** Build the memory section for the system prompt. */
export function buildMemoryPromptSection(cwd?: string): string {
  const memories = listMemories(cwd);
  if (memories.length === 0) return "";

  const sections: string[] = ["\n# Remembered Context"];

  for (const m of memories) {
    sections.push(`\n## [${m.type}] ${m.name}\n${m.content}`);
  }

  return sections.join("\n");
}
