import type Anthropic from "@anthropic-ai/sdk";

export type ToolDefinition = Anthropic.Messages.Tool;

export type ToolHandler = (
  input: Record<string, unknown>
) => Promise<string>;

export interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export function getAllTools(): ToolEntry[] {
  // TODO: Register file, bash, and search tools
  return [];
}
