import * as readline from "node:readline/promises";
import chalk from "chalk";
import type { Agent } from "@/core/agent";
import { getSkillByName, resolveSkillPrompt } from "@/core/skills";

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------

function printWelcome(): void {
  console.log(
    chalk.bold.cyan("\n  NexusClaw") +
      chalk.gray(" — assistant CLI\n")
  );
  console.log(chalk.gray("  Type your request, or 'exit' to quit."));
  console.log(chalk.gray("  Commands: /clear /plan /cost /compact /memory /skills\n"));
}

function printUserPrompt(): void {
  process.stdout.write(chalk.bold.green("\n> "));
}

function printError(message: string): void {
  console.error(chalk.red(`\n  Error: ${message}`));
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

      // Skill slash-command: /skill-name [args]
      if (input.startsWith("/")) {
        const spaceIdx = input.indexOf(" ");
        const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
        const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
        const skill = getSkillByName(cmdName);
        if (skill && skill.userInvocable) {
          const resolved = resolveSkillPrompt(skill, cmdArgs);
          console.error(`  ℹ Invoking skill: ${skill.name}`);
          try { await agent.chat(resolved); } catch (e: any) {
            if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
          }
          askQuestion(); return;
        }
      }

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
