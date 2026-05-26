// ---------------------------------------------------------------------------
// Pairing-state file — pending pairing requests live here (transient,
// bot-managed state, kept separate from the user-edited nexusclaw.json).
//
// File: ~/.nexusclaw/pairing.json
//
// Atomic writes use the standard temp-file + rename trick so the host CLI
// and the running serve process never see a torn write.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PendingRequest = z.object({
  code: z.string(),
  username: z.string().optional(),
  firstName: z.string().optional(),
  requestedAt: z.string(),
});

export const PlatformPending = z.object({
  /** Keyed by native userId. */
  pending: z.record(z.string(), PendingRequest).default({}),
});

export const PairingState = z.object({
  telegram: PlatformPending.default({ pending: {} }),
});

export type PendingRequest = z.infer<typeof PendingRequest>;
export type PlatformPending = z.infer<typeof PlatformPending>;
export type PairingState = z.infer<typeof PairingState>;

export const DEFAULT_PAIRING_PATH = join(homedir(), ".nexusclaw", "pairing.json");

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export function loadPairing(path: string = DEFAULT_PAIRING_PATH): PairingState {
  if (!existsSync(path)) return { telegram: { pending: {} } };
  const raw = readFileSync(path, "utf-8");
  return PairingState.parse(JSON.parse(raw));
}

export function savePairing(state: PairingState, path: string = DEFAULT_PAIRING_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Mutators — read, modify, write atomically. The host CLI and the server
// share this file, so every mutation goes through a fresh read.
// ---------------------------------------------------------------------------

export function addPending(
  platform: "telegram",
  userId: string,
  req: PendingRequest,
  path: string = DEFAULT_PAIRING_PATH,
): void {
  const state = loadPairing(path);
  state[platform].pending[userId] = req;
  savePairing(state, path);
}

/** Find a pending request by its pairing code. Returns the platform + userId. */
export function findByCode(
  code: string,
  path: string = DEFAULT_PAIRING_PATH,
): { platform: "telegram"; userId: string; request: PendingRequest } | null {
  const state = loadPairing(path);
  for (const [userId, request] of Object.entries(state.telegram.pending)) {
    if (request.code === code) return { platform: "telegram", userId, request };
  }
  return null;
}

export function removePending(
  platform: "telegram",
  userId: string,
  path: string = DEFAULT_PAIRING_PATH,
): void {
  const state = loadPairing(path);
  delete state[platform].pending[userId];
  savePairing(state, path);
}

// ---------------------------------------------------------------------------
// Watcher — debounced fs.watch over the pairing file. Approval / new
// pending writes fire onChange so the running serve can refresh its
// in-memory snapshot.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 100;

export function watchPairing(
  onChange: () => void,
  path: string = DEFAULT_PAIRING_PATH,
): { close: () => void } {
  mkdirSync(dirname(path), { recursive: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== null && filename !== "pairing.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; onChange(); }, DEBOUNCE_MS);
    });
  } catch {
    // best-effort — if the directory can't be watched, the server still
    // works, just without live updates.
  }
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}
