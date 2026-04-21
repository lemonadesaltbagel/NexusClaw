import type { ToolEntry } from "@/tools/index";

export function bashTool(): ToolEntry {
  return {
    definition: {
      name: "bash",
      description: "Execute a shell command and return its output",
      input_schema: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
      },
    },
    handler: async (_input) => {
      // TODO: Implement bash execution
      return "not yet implemented";
    },
  };
}
