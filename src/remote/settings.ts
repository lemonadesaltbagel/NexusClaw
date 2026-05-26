// ---------------------------------------------------------------------------
// Remote-control settings loader.
//
// Reads ~/.nexusclaw/nexusclaw.json. The whitelist (userMap) doubles as the
// identity resolver: native ids that are not in the map are denied.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { IdentityResolver } from "@/remote/gateway";
import type { RemoteIdentity } from "@/remote/types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const GroupPolicySchema = z.object({
  policy: z.enum(["disabled", "open", "allowlist"]),
  allowedUsers: z.array(z.string()).default([]),
  topics: z.record(z.string(), z.object({ enabled: z.boolean() })).default({}),
});

export const DmPolicySchema = z.object({
  policy: z.enum(["disable", "open", "allowlist", "pairing"]),
});

export const TelegramSettings = z.object({
  token: z.string().min(1),
  /** Native userId → canonical userId. Acts as the DM whitelist. */
  userMap: z.record(z.string(), z.string()).default({}),
  /** chatId → group/forum policy. Missing chat means denied. */
  groups: z.record(z.string(), GroupPolicySchema).default({}),
  /** DM access policy. Default: allowlist (current behavior). */
  dm: DmPolicySchema.default({ policy: "allowlist" }),
});

export const RemoteSettings = z.object({
  telegram: TelegramSettings.optional(),
});

export const NexusClawSettings = z.object({
  remote: RemoteSettings.default({}),
});

export type TelegramSettings = z.infer<typeof TelegramSettings>;
export type RemoteSettings  = z.infer<typeof RemoteSettings>;
export type NexusClawSettings = z.infer<typeof NexusClawSettings>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS_PATH = join(homedir(), ".nexusclaw", "nexusclaw.json");

/** Read + parse settings. Returns null if the file does not exist. Throws on bad JSON / schema. */
export function loadSettings(path: string = DEFAULT_SETTINGS_PATH): NexusClawSettings | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw);
  return NexusClawSettings.parse(json);
}

// ---------------------------------------------------------------------------
// Mutators — pairing approval writes a userMap entry. Atomic via temp + rename.
// ---------------------------------------------------------------------------

export function appendUserMap(
  platform: "telegram",
  nativeUserId: string,
  canonicalUserId: string,
  path: string = DEFAULT_SETTINGS_PATH,
): void {
  // Read what's there (may be missing or invalid; we want to fail loudly if
  // the file exists but is corrupt rather than overwrite it).
  const json: Record<string, unknown> = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf-8"))
    : {};
  // Surgical merge — keep all unrelated fields exactly as the user wrote them.
  json.remote = (json.remote as Record<string, unknown> | undefined) ?? {};
  const remote = json.remote as Record<string, unknown>;
  remote[platform] = (remote[platform] as Record<string, unknown> | undefined) ?? {};
  const block = remote[platform] as Record<string, unknown>;
  block.userMap = (block.userMap as Record<string, string> | undefined) ?? {};
  (block.userMap as Record<string, string>)[nativeUserId] = canonicalUserId;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(json, null, 2));
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Live updates — fs.watch with a small debounce so the running serve can
// re-read settings after the pairing CLI rewrites userMap.
// ---------------------------------------------------------------------------

const SETTINGS_DEBOUNCE_MS = 100;

export function watchSettings(
  onChange: () => void,
  path: string = DEFAULT_SETTINGS_PATH,
): { close: () => void } {
  mkdirSync(dirname(path), { recursive: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dirname(path), (_event, filename) => {
      if (filename !== null && filename !== "nexusclaw.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; onChange(); }, SETTINGS_DEBOUNCE_MS);
    });
  } catch { /* best-effort */ }
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Identity resolver — combine every adapter's userMap into one lookup.
//
// Unknown native ids → null (denied). This is the gateway's whitelist.
// ---------------------------------------------------------------------------

export function buildIdentityResolver(settings: NexusClawSettings | null): IdentityResolver {
  if (!settings) return () => null;

  // platform → native userId → canonical userId
  const tables: Record<string, Record<string, string>> = {};
  if (settings.remote.telegram) tables["telegram"] = settings.remote.telegram.userMap;

  return (id: RemoteIdentity): string | null => {
    const table = tables[id.platform];
    if (!table) return null;
    return table[id.userId] ?? null;
  };
}
