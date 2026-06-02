// ---------------------------------------------------------------------------
// Tool executor — dispatches tool calls to their implementations and
// enforces a result size cap (50K chars) to protect context windows.
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "@/tools/handlers/file_ops";
import { editFile } from "@/tools/handlers/edit_file";
import { listFiles } from "@/tools/handlers/list_files";
import { grepSearch } from "@/tools/handlers/grep_search";
import { runShell } from "@/tools/handlers/run_shell";
import { webFetch } from "@/tools/handlers/web_fetch";
import { analyzeImage } from "@/tools/handlers/analyze_image";
import { toolDefinitions, activatedTools, getActiveImageTool } from "@/tools/definitions";
import { resolveImageProvider } from "@/tools/image-provider";
import { executeSkill } from "@/core/skills";
import type { McpManager } from "@/core/mcp";

/** Tracks mtimeMs for files that have been read — used to enforce read-before-write. */
export const readFileState = new Map<string, number>();

/** Global MCP manager — set via setMcpManager() during startup. */
let mcpManager: McpManager | null = null;

export function setMcpManager(manager: McpManager): void {
  mcpManager = manager;
}

export function getMcpManager(): McpManager | null {
  return mcpManager;
}

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
    case "read_file": {
      result = readFile(input as { file_path: string });
      if (!result.startsWith("Error")) {
        const absPath = resolve(input.file_path as string);
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    }
    case "write_file": {
      const absPath = resolve(input.file_path as string);
      if (existsSync(absPath)) {
        if (!readFileState.has(absPath)) {
          result = "Error: You must read this file before writing. Use read_file first.";
          break;
        }
        const cur = statSync(absPath).mtimeMs;
        if (cur !== readFileState.get(absPath)!) {
          readFileState.delete(absPath);
          result = "Warning: file was modified externally since last read. Please read_file again.";
          break;
        }
      }
      result = writeFile(input as { file_path: string; content: string });
      if (!result.startsWith("Error")) {
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    }
    case "edit_file": {
      const absPath = resolve(input.file_path as string);
      if (!readFileState.has(absPath)) {
        result = "Error: You must read this file before editing. Use read_file first.";
        break;
      }
      const cur = statSync(absPath).mtimeMs;
      if (cur !== readFileState.get(absPath)!) {
        readFileState.delete(absPath);
        result = "Warning: file was modified externally since last read. Please read_file again.";
        break;
      }
      result = editFile(
        input as { file_path: string; old_string: string; new_string: string },
      );
      if (!result.startsWith("Error")) {
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    }
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
    case "web_fetch":
      result = await webFetch(input as { url: string; max_length?: number });
      break;
    case "analyze_image": {
      const gated = getActiveImageTool();
      if (!gated) { result = "Error: analyze_image is not available in this environment."; break; }
      const provider = resolveImageProvider(gated.provider, gated.model);
      if (!provider) { result = "Error: image provider could not be resolved."; break; }
      const out = await analyzeImage(
        input as { image?: string; images?: string[]; prompt?: string },
        { provider, workspaceDir: process.cwd() },
      );
      if ("error" in out) {
        if (out.error === "too_many_images") result = `Error: too many images (${out.count} > 20).`;
        else if (out.error === "no_images")     result = "Error: no image was provided.";
        else if (out.error === "no_provider")   result = "Error: image provider missing at execution time.";
        else if (out.error === "read_failed")   result = `Error: could not read "${out.path}": ${out.cause}`;
        else if (out.error === "model_failed")  result = "Error: vision model call failed: " + (out.attempts.at(-1)?.error ?? "unknown");
        else                                    result = "Error: analyze_image failed.";
      } else {
        result = out.content[0]!.text;
      }
      break;
    }
    case "skill": {
      const skillResult = executeSkill(
        input.skill_name as string,
        (input.args as string) || "",
      );
      if (!skillResult) {
        result = `Unknown skill: ${input.skill_name}`;
        break;
      }
      result = `[Skill "${input.skill_name}" activated]\n\n${skillResult.prompt}`;
      break;
    }
    case "tool_search": {
      const query = ((input.query as string) || "").toLowerCase();
      const deferred = toolDefinitions.filter((t) => t.deferred);
      const matches = deferred.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          (t.description || "").toLowerCase().includes(query),
      );
      if (matches.length === 0) {
        result = "No matching deferred tools found.";
        break;
      }
      for (const m of matches) activatedTools.add(m.name);
      result = JSON.stringify(
        matches.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        null,
        2,
      );
      break;
    }
    default: {
      // Check if this is an MCP tool (prefixed with "mcp__")
      if (mcpManager && mcpManager.isMcpTool(name)) {
        result = await mcpManager.callTool(name, input);
        break;
      }
      return `Unknown tool: ${name}`;
    }
  }

  return truncateResult(result);
}
