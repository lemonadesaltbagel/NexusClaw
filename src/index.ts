#!/usr/bin/env bun
import { program } from "commander";
import { chatCommand } from "@/cli/commands";
import { serveCommand } from "@/cli/serve";
import { pairingCommand } from "@/cli/pairing";

program
  .name("nexusclaw")
  .description("NexusClaw — assistant CLI powered by Claude")
  .version("0.1.0");

program.addCommand(chatCommand, { isDefault: true });
program.addCommand(serveCommand);
program.addCommand(pairingCommand);

program.parse();
