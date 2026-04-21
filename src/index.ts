#!/usr/bin/env bun
import { program } from "commander";
import { chatCommand } from "@/cli/commands";

program
  .name("nexuscode")
  .description("A coding agent CLI powered by Claude")
  .version("0.1.0");

program.addCommand(chatCommand);

program.parse();
