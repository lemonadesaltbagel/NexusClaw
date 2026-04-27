// ---------------------------------------------------------------------------
// Tool executor — dispatches tool calls to their implementations and
// enforces a result size cap (50K chars) to protect context windows.
// ---------------------------------------------------------------------------

import { readFile } from "@/tools/handlers/read_file";
import { writeFile } from "@/tools/handlers/write_file";
import { editFile } from "@/tools/handlers/edit_file";
import { listFiles } from "@/tools/handlers/list_files";
import { grepSearch } from "@/tools/handlers/grep_search";
import { runShell } from "@/tools/handlers/run_shell";

const MAX_RESULT_CHARS = 50_000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    "\n\n[... truncated " + (result.length - keepEach * 2) + " chars ...]\n\n" +
    result.slice(-keepEach)
  );
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  let result: string;

  switch (name) {
    case "read_file":
      result = readFile(input as { file_path: string });
      break;
    case "write_file":
      result = writeFile(input as { file_path: string; content: string });
      break;
    case "edit_file":
      result = editFile(
        input as { file_path: string; old_string: string; new_string: string },
      );
      break;
    case "list_files":
      result = await listFiles(input as { pattern: string; path?: string });
      break;
    case "grep_search":
      result = grepSearch(
        input as { pattern: string; path?: string; include?: string },
      );
      break;
    case "run_shell":
      result = runShell(input as { command: string; timeout?: number });
      break;
    default:
      return `Unknown tool: ${name}`;
  }

  return truncateResult(result);
}
