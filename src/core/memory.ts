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

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from "fs";
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

/** Header info scanned from a memory file (without reading full body). */
export interface MemoryHeader {
  filename: string;
  filePath: string;
  name: string;
  description: string;
  type: MemoryType;
  mtimeMs: number;
}

/** A memory selected by semantic recall, with full content loaded. */
export interface RelevantMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
}

/** Signature for the side-query function provided by the agent. */
export type SideQueryFn = (
  system: string,
  userMessage: string,
  signal?: AbortSignal,
) => Promise<string>;

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
// Semantic recall (sideQuery)
// ---------------------------------------------------------------------------

const MAX_MEMORY_BYTES_PER_FILE = 4096;

const SELECT_MEMORIES_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`;

/** Scan memory directory for file headers without reading full content. */
export function scanMemoryHeaders(cwd?: string): MemoryHeader[] {
  const dir = getMemoryDir(cwd);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );

  const headers: MemoryHeader[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const { meta } = parseFrontmatter(raw);
      if (meta.name && meta.type) {
        const stat = statSync(filePath);
        headers.push({
          filename: file,
          filePath,
          name: meta.name,
          description: meta.description ?? "",
          type: meta.type as MemoryType,
          mtimeMs: stat.mtimeMs,
        });
      }
    } catch {
      // skip malformed files
    }
  }
  return headers;
}

/** Format memory headers into a manifest string for the LLM. */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => `- ${h.filename}: [${h.type}] ${h.name} — ${h.description}`)
    .join("\n");
}

/** Return a human-readable age string for a memory file. */
export function memoryAge(mtimeMs: number): string {
  const diffMs = Date.now() - mtimeMs;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  return `${months} months ago`;
}

/** Return a staleness warning if the memory is old, or empty string. */
export function memoryFreshnessWarning(mtimeMs: number): string {
  const diffMs = Date.now() - mtimeMs;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days > 90) return "⚠️ This memory is over 3 months old and may be outdated.";
  if (days > 30) return "⚠️ This memory is over 1 month old — verify before acting on it.";
  return "";
}

/**
 * Use an LLM side query to select memories relevant to the user's query.
 * Memories already surfaced in this session are excluded.
 * Fails silently — memory recall should never block the main loop.
 */
export async function selectRelevantMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  signal?: AbortSignal,
  cwd?: string,
): Promise<RelevantMemory[]> {
  const headers = scanMemoryHeaders(cwd);
  if (headers.length === 0) return [];

  // Filter out memories already surfaced in this session
  const candidates = headers.filter((h) => !alreadySurfaced.has(h.filePath));
  if (candidates.length === 0) return [];

  const manifest = formatMemoryManifest(candidates);

  try {
    const text = await sideQuery(
      SELECT_MEMORIES_PROMPT,
      `Query: ${query}\n\nAvailable memories:\n${manifest}`,
      signal,
    );

    // Extract JSON from response (model may wrap in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedFilenames: string[] = parsed.selected_memories || [];

    // Map filenames back to headers, read full content
    const filenameSet = new Set(selectedFilenames);
    const selected = candidates.filter((h) => filenameSet.has(h.filename));

    return selected.slice(0, 5).map((h) => {
      let content = readFileSync(h.filePath, "utf-8");
      // Per-file truncation (4KB)
      if (Buffer.byteLength(content) > MAX_MEMORY_BYTES_PER_FILE) {
        content = content.slice(0, MAX_MEMORY_BYTES_PER_FILE) +
          "\n\n[... truncated, memory file too large ...]";
      }
      const freshness = memoryFreshnessWarning(h.mtimeMs);
      const headerText = freshness
        ? `${freshness}\n\nMemory: ${h.filePath}:`
        : `Memory (saved ${memoryAge(h.mtimeMs)}): ${h.filePath}:`;

      return { path: h.filePath, content, mtimeMs: h.mtimeMs, header: headerText };
    });
  } catch (err: any) {
    // Silent failure -- memory recall should never block the main loop
    if (signal?.aborted) return [];
    console.error(`[memory] semantic recall failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// System prompt integration
// ---------------------------------------------------------------------------

/** Build the memory section for the system prompt. */
export function buildMemoryPromptSection(cwd?: string): string {
  const index = loadMemoryIndex(cwd);
  const memoryDir = getMemoryDir(cwd);

  return `# Memory System

You have a persistent, file-based memory system at \`${memoryDir}\`.

## Memory Types
- **user**: User's role, preferences, knowledge level
- **feedback**: Corrections and guidance from the user
- **project**: Ongoing work, goals, deadlines, decisions
- **reference**: Pointers to external resources

## How to Save Memories
Use the write_file tool to create a memory file with YAML frontmatter:

\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user | feedback | project | reference}}
---

{{memory content}}
\`\`\`

Save to: \`${memoryDir}/\`
Filename format: \`{type}_{slugified_name}.md\`

After saving, update the index file at \`${memoryDir}/MEMORY.md\` with a one-line pointer.

## What NOT to Save
- Code patterns or architecture (read the code instead)
- Git history (use git log)
- Anything already in CLAUDE.md
- Ephemeral task details

${index ? `## Current Memory Index\n${index}` : "(No memories saved yet.)"}`;
}
