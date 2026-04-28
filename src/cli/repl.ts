import * as readline from "node:readline/promises";
import type { Agent } from "@/core/agent";

// ---------------------------------------------------------------------------
// Print helpers (stubs)
// ---------------------------------------------------------------------------

function printWelcome(): void {
  // TODO: implement welcome banner
}

function printUserPrompt(): void {
  // TODO: implement user prompt indicator
}

function printError(message: string): void {
  // TODO: implement styled error output
  console.error(message);
}

// ---------------------------------------------------------------------------
// REPL — interactive read-eval-print loop for the coding agent.
// ---------------------------------------------------------------------------

export async function runRepl(agent: Agent): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let sigintCount = 0;
  process.on("SIGINT", () => {
    if (agent.isProcessing) {
      agent.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0;
      printUserPrompt();
    } else {
      sigintCount++;
      if (sigintCount >= 2) { console.log("\nBye!\n"); process.exit(0); }
      console.log("\n  Press Ctrl+C again to exit.");
      printUserPrompt();
    }
  });

  printWelcome();

  // rl.once instead of rl.on: ensures strict serialization, prevents
  // multiple chats from concurrently modifying message history
  const askQuestion = (): void => {
    printUserPrompt();
    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;

      if (!input) { askQuestion(); return; }
      if (input === "exit" || input === "quit") { console.log("\nBye!\n"); process.exit(0); }

      if (input === "/clear") { agent.clearHistory(); askQuestion(); return; }
      if (input === "/cost")  { agent.showCost(); askQuestion(); return; }
      if (input === "/compact") {
        try { await agent.compact(); } catch (e: any) { printError(e.message); }
        askQuestion(); return;
      }
      if (input === "/plan") { agent.togglePlanMode(); askQuestion(); return; }

      try {
        await agent.chat(input);
      } catch (e: any) {
        if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
      }

      askQuestion();
    });
  };

  askQuestion();
}
