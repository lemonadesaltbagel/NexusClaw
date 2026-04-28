import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { MessageParam } from "@/core/types";

// ---------------------------------------------------------------------------
// Session persistence — save/load conversation history to disk.
// ---------------------------------------------------------------------------

const SESSION_DIR = join(homedir(), ".mini-claude", "sessions");

export interface SessionMetadata {
  id: string;
  model: string;
  cwd: string;
  startTime: string;
  messageCount: number;
}

export interface SessionData {
  metadata: SessionMetadata;
  messages: MessageParam[];
}

function ensureDir(): void {
  mkdirSync(SESSION_DIR, { recursive: true });
}

export function saveSession(id: string, data: SessionData): void {
  ensureDir();
  writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

export function loadSession(id: string): SessionData | null {
  try {
    const raw = readFileSync(join(SESSION_DIR, `${id}.json`), "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export interface SessionSummary {
  id: string;
  startTime: string;
}

export function listSessions(): SessionSummary[] {
  try {
    ensureDir();
    const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
    const sessions: SessionSummary[] = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(SESSION_DIR, file), "utf-8");
        const data = JSON.parse(raw) as SessionData;
        sessions.push({ id: data.metadata.id, startTime: data.metadata.startTime });
      } catch {
        // skip corrupt session files
      }
    }

    return sessions;
  } catch {
    return [];
  }
}

export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return sessions[0]!.id;
}
