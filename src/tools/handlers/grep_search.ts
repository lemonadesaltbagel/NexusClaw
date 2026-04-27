import { execSync } from "node:child_process";

export function grepSearch(input: {
  pattern: string;
  path?: string;
  include?: string;
}): string {
  try {
    const args = ["--line-number", "--color=never", "-r"];
    if (input.include) args.push(`--include=${input.include}`);
    args.push(input.pattern);
    args.push(input.path || ".");
    const result = execSync(`grep ${args.join(" ")}`, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });
    const lines = result.split("\n").filter(Boolean);
    return lines.slice(0, 100).join("\n") +
      (lines.length > 100 ? `\n... and ${lines.length - 100} more matches` : "");
  } catch (e: any) {
    if (e.status === 1) return "No matches found.";
    return `Error: ${e.message}`;
  }
}
