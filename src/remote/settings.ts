// ---------------------------------------------------------------------------
// Remote-control settings loader.
//
// Reads ~/.nexusclaw/nexusclaw.json. The whitelist (userMap) doubles as the
// identity resolver: native ids that are not in the map are denied.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { IdentityResolver } from "@/remote/gateway";
import type { RemoteIdentity } from "@/remote/types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const TelegramSettings = z.object({
  token: z.string().min(1),
  /** Native userId → canonical userId. Acts as the whitelist. */
  userMap: z.record(z.string(), z.string()).default({}),
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
