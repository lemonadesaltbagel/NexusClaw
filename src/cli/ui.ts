import chalk from "chalk";

// ---------------------------------------------------------------------------
// UI output helpers — human-facing display for tool calls and results.
// These are display-only; the full untruncated data is always kept in
// the message history sent to the model.
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, string> = {
  read_file: "\u{1F4D6}",    // 📖
  write_file: "\u{1F4DD}",   // 📝
  edit_file: "\u{270F}\uFE0F", // ✏️
  list_files: "\u{1F4C2}",   // 📂
  grep_search: "\u{1F50D}",  // 🔍
  run_shell: "\u{1F4BB}",    // 💻
  web_fetch: "\u{1F310}",    // 🌐
  tool_search: "\u{1F50E}",  // 🔎
};

function getToolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "\u{1F527}"; // 🔧 default
}

function getToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":
      return String(input.file_path ?? "");
    case "write_file":
      return String(input.file_path ?? "");
    case "edit_file":
      return String(input.file_path ?? "");
    case "list_files":
      return String(input.pattern ?? "");
    case "grep_search": {
      const parts = [String(input.pattern ?? "")];
      if (input.path) parts.push(`in ${input.path}`);
      return parts.join(" ");
    }
    case "run_shell":
      return String(input.command ?? "");
    case "web_fetch":
      return String(input.url ?? "");
    case "tool_search":
      return String(input.query ?? "");
    default:
      return "";
  }
}

export function printToolCall(name: string, input: Record<string, unknown>): void {
  const icon = getToolIcon(name);
  const summary = getToolSummary(name, input);
  console.log(chalk.yellow(`\n  ${icon} ${name}`) + chalk.gray(` ${summary}`));
}

export function printToolResult(name: string, result: string): void {
  const maxLen = 500;
  const truncated =
    result.length > maxLen
      ? result.slice(0, maxLen) + chalk.gray(`\n  ... (${result.length} chars total)`)
      : result;
  console.log(chalk.dim(truncated.split("\n").map((l) => "  " + l).join("\n")));
}
