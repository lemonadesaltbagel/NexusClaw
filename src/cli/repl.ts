import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Agent } from "@/core/agent";

// ---------------------------------------------------------------------------
// REPL — interactive read-eval-print loop for the coding agent.
// ---------------------------------------------------------------------------

export async function runRepl(agent: Agent): Promise<void> {
  const rl = readline.createInterface({ input, output });

  console.log("\nnexuscode — interactive mode. Type /exit or Ctrl-D to quit.\n");

  // Graceful Ctrl-C: abort the current turn instead of killing the process.
  process.on("SIGINT", () => {
    agent.abort();
    // Print a newline so the next prompt isn't on the same line as ^C
    process.stdout.write("\n");
  });

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question("> ");
      } catch {
        // EOF (Ctrl-D) — exit gracefully
        break;
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      // Built-in slash commands
      if (trimmed === "/exit" || trimmed === "/quit") break;

      if (trimmed === "/clear") {
        agent.clearMessages();
        console.log("Conversation cleared.\n");
        continue;
      }

      if (trimmed === "/history") {
        const msgs = agent.getMessages();
        console.log(`${msgs.length} message(s) in conversation.\n`);
        continue;
      }

      try {
        await agent.chat(trimmed);
      } catch (err) {
        console.error(
          `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      // Blank line between turns for readability
      process.stdout.write("\n");
    }
  } finally {
    rl.close();
  }

  console.log("Goodbye.");
}
