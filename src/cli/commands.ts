import { Command } from "commander";

export const chatCommand = new Command("chat")
  .description("Start an interactive coding agent session")
  .action(async () => {
    console.log("nexuscode chat session — not yet implemented");
  });
