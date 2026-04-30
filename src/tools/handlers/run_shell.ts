import { execSync } from "node:child_process";
import { isDangerous } from "@/tools/dangerous";

export function runShell(input: { command: string; timeout?: number }): string {
  if (isDangerous(input.command)) {
    return `Blocked: command matched a dangerous pattern and was not executed.\nCommand: ${input.command}`;
  }

  try {
    const result = execSync(input.command, {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: input.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result || "(no output)";
  } catch (e: any) {
    const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
    const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
    return `Command failed (exit code ${e.status})${stdout}${stderr}`;
  }
}
