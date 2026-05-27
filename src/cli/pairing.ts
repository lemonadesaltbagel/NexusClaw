// ---------------------------------------------------------------------------
// `nexusclaw pairing <list|approve> <platform> [...]`
//
// Host-side commands that read and mutate ~/.nexusclaw/pairing.json and (on
// approve) ~/.nexusclaw/nexusclaw.json. The running serve process picks up
// changes via fs.watch.
// ---------------------------------------------------------------------------

import { Command } from "commander";
import chalk from "chalk";

import {
  DEFAULT_PAIRING_PATH,
  findByCode,
  loadPairing,
  removePending,
} from "@/remote/pairing";
import {
  DEFAULT_SETTINGS_PATH,
  appendUserMap,
} from "@/remote/settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultCanonical(userId: string, username?: string): string {
  if (username && username.length > 0) return username;
  return `tg_${userId}`;
}

// ---------------------------------------------------------------------------
// `pairing list <platform>`
// ---------------------------------------------------------------------------

const pairingListCommand = new Command("list")
  .description("List pending pairing requests")
  .argument("<platform>", "Platform name, e.g. 'telegram'")
  .option("--pairing-path <path>", "Path to pairing.json", DEFAULT_PAIRING_PATH)
  .action((platform: string, opts) => {
    if (platform !== "telegram") {
      console.error(`Unknown platform: ${platform}`);
      process.exit(1);
    }
    const state = loadPairing(opts.pairingPath);
    const entries = Object.entries(state.telegram.pending);
    if (entries.length === 0) {
      console.log("No pending pairing requests.");
      return;
    }
    console.log(`Pending pairing requests (${entries.length}):\n`);
    for (const [userId, req] of entries) {
      const who = req.username ? `@${req.username}` : (req.firstName ?? "?");
      console.log(`  ${chalk.bold(req.code)}  user ${userId}  ${chalk.gray(who)}  ${chalk.gray(req.requestedAt)}`);
    }
    console.log("\nApprove with: nexusclaw pairing approve telegram <code> [--as <canonicalId>]");
  });

// ---------------------------------------------------------------------------
// `pairing approve <platform> <code> [--as <canonicalId>]`
// ---------------------------------------------------------------------------

const pairingApproveCommand = new Command("approve")
  .description("Approve a pending pairing request by its code")
  .argument("<platform>", "Platform name, e.g. 'telegram'")
  .argument("<code>", "Pairing code from the bot's message to the user")
  .option("--as <canonicalId>", "Override the canonical user id (default: telegram username or tg_<userId>)")
  .option("--pairing-path <path>", "Path to pairing.json", DEFAULT_PAIRING_PATH)
  .option("--config <path>", "Path to nexusclaw.json", DEFAULT_SETTINGS_PATH)
  .action((platform: string, code: string, opts) => {
    if (platform !== "telegram") {
      console.error(`Unknown platform: ${platform}`);
      process.exit(1);
    }
    const match = findByCode(code, opts.pairingPath);
    if (!match) {
      console.error(`No pending request with code ${code}.`);
      process.exit(1);
    }
    const canonical: string = opts.as ?? defaultCanonical(match.userId, match.request.username);
    appendUserMap("telegram", match.userId, canonical, opts.config);
    removePending("telegram", match.userId, opts.pairingPath);
    console.log(
      `Approved ${chalk.bold(code)}: telegram user ${match.userId} → ${chalk.bold(canonical)}`,
    );
  });

// ---------------------------------------------------------------------------
// `pairing deny <platform> <code>` — drop a pending request without
// granting access. No userMap write.
// ---------------------------------------------------------------------------

const pairingDenyCommand = new Command("deny")
  .description("Reject a pending pairing request by its code (no userMap entry)")
  .argument("<platform>", "Platform name, e.g. 'telegram'")
  .argument("<code>", "Pairing code from the bot's message to the user")
  .option("--pairing-path <path>", "Path to pairing.json", DEFAULT_PAIRING_PATH)
  .action((platform: string, code: string, opts) => {
    if (platform !== "telegram") {
      console.error(`Unknown platform: ${platform}`);
      process.exit(1);
    }
    const match = findByCode(code, opts.pairingPath);
    if (!match) {
      console.error(`No pending request with code ${code}.`);
      process.exit(1);
    }
    removePending("telegram", match.userId, opts.pairingPath);
    console.log(`Denied ${chalk.bold(code)}: telegram user ${match.userId} dropped.`);
  });

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export const pairingCommand = new Command("pairing")
  .description("Manage pending pairing requests")
  .addCommand(pairingListCommand)
  .addCommand(pairingApproveCommand)
  .addCommand(pairingDenyCommand);
