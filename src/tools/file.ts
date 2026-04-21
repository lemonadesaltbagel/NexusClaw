import type { ToolEntry } from "@/tools/index";

export function fileReadTool(): ToolEntry {
  return {
    definition: {
      name: "file_read",
      description: "Read the contents of a file",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
        },
        required: ["path"],
      },
    },
    handler: async (_input) => {
      // TODO: Implement file read
      return "not yet implemented";
    },
  };
}

export function fileWriteTool(): ToolEntry {
  return {
    definition: {
      name: "file_write",
      description: "Write content to a file",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Absolute path to the file" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
    },
    handler: async (_input) => {
      // TODO: Implement file write
      return "not yet implemented";
    },
  };
}
