import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function writeFile(input: { file_path: string; content: string }): string {
  try {
    mkdirSync(dirname(input.file_path), { recursive: true });
    writeFileSync(input.file_path, input.content);
    return `Successfully wrote to ${input.file_path}`;
  } catch (e: any) {
    return `Error writing file: ${e.message}`;
  }
}
