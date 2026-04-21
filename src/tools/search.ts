import type { ToolEntry } from "@/tools/index";

export function grepTool(): ToolEntry {
  return {
    definition: {
      name: "grep",
      description: "Search file contents using a regex pattern",
      input_schema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory or file to search in" },
        },
        required: ["pattern"],
      },
    },
    handler: async (_input) => {
      // TODO: Implement grep search
      return "not yet implemented";
    },
  };
}

export function globTool(): ToolEntry {
  return {
    definition: {
      name: "glob",
      description: "Find files matching a glob pattern",
      input_schema: {
        type: "object" as const,
        properties: {
          pattern: { type: "string", description: "Glob pattern to match files" },
          path: { type: "string", description: "Directory to search in" },
        },
        required: ["pattern"],
      },
    },
    handler: async (_input) => {
      // TODO: Implement glob search
      return "not yet implemented";
    },
  };
}
