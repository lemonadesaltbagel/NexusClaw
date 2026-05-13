import { Glob } from "bun";
import { sep } from "node:path";

export async function listFiles(input: {
  pattern: string;
  path?: string;
}): Promise<string> {
  try {
    const base = input.path || ".";
    const pattern = input.pattern;
    const files: string[] = [];
    const glob = new Glob(pattern);
    for await (const p of glob.scan({ cwd: base, onlyFiles: true })) {
      const rel = base === "." ? p : p;
      if (rel.includes("node_modules") || rel.split(sep).includes(".git")) {
        continue;
      }
      files.push(rel);
      if (files.length >= 200) break;
    }
    if (files.length === 0) {
      return "No files found matching the pattern.";
    }
    let result = files.slice(0, 200).join("\n");
    if (files.length > 200) {
      result += `\n... and ${files.length - 200} more`;
    }
    return result;
  } catch (e: any) {
    return `Error listing files: ${e?.message ?? e}`;
  }
}
