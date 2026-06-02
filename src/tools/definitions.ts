// ---------------------------------------------------------------------------
// Tool definitions — static metadata sent to the Anthropic API.
// No implementation logic lives here; see individual tool files for that.
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** When true, the tool's full schema is withheld until activated via tool_search. */
  deferred?: boolean;
}

export const toolDefinitions: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to read",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to write",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation).",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to edit",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace",
        },
        new_string: {
          type: "string",
          description: "The string to replace it with",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description:
      "List files matching a glob pattern. Returns matching file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description:
            'Glob pattern to match files (e.g., "**/*.ts", "src/**/*")',
        },
        path: {
          type: "string",
          description:
            "Base directory to search from. Defaults to current directory.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    description:
      "Search for a pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "The regex pattern to search for",
        },
        path: {
          type: "string",
          description:
            "Directory or file to search in. Defaults to current directory.",
        },
        include: {
          type: "string",
          description:
            'File glob pattern to include (e.g., "*.ts", "*.py")',
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return its content as text. For HTML pages, tags are stripped.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        max_length: {
          type: "number",
          description: "Maximum content length (default 50000)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "run_shell",
    description:
      "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "skill",
    description:
      "Invoke a registered skill by name. Skills are reusable prompt templates discovered from .claude/skills/ directories.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: {
          type: "string",
          description: "The name of the skill to invoke",
        },
        args: {
          type: "string",
          description: "Arguments to pass to the skill template",
        },
      },
      required: ["skill_name"],
    },
  },
  {
    name: "agent",
    description:
      "Launch a sub-agent to handle a task autonomously. Sub-agents have isolated context " +
      "and return their result. Types: 'explore' (read-only, fast search), " +
      "'plan' (read-only, structured planning), 'general' (full tools).",
    input_schema: {
      type: "object" as const,
      properties: {
        description: {
          type: "string",
          description: "Short (3-5 word) description of the sub-agent's task",
        },
        prompt: {
          type: "string",
          description: "Detailed task instructions for the sub-agent",
        },
        type: {
          type: "string",
          enum: ["explore", "plan", "general"],
          description: "Agent type. Default: general",
        },
      },
      required: ["description", "prompt"],
    },
  },
  {
    name: "tool_search",
    description:
      "Search for available tools by name or keyword. Returns full schemas for matching deferred tools and activates them for use.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Tool name or search keywords",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "enter_plan_mode",
    description:
      "Enter plan mode to switch to a read-only planning phase. In plan mode, you can only read files and write to the plan file. Use this when you need to explore the codebase and design an implementation plan before making changes.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
    deferred: true,
  },
  {
    name: "exit_plan_mode",
    description:
      "Exit plan mode after you have finished writing your plan to the plan file. The user will review and approve the plan before you proceed with implementation.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
    deferred: true,
  },
];

// ---------------------------------------------------------------------------
// Concurrency-safe tools — read-only tools that can safely run in parallel.
// Used by the Agent to batch consecutive tool calls via Promise.all.
// ---------------------------------------------------------------------------

export const CONCURRENCY_SAFE_TOOLS = new Set([
  "read_file",
  "list_files",
  "grep_search",
  "web_fetch",
]);

// ---------------------------------------------------------------------------
// Deferred tool activation
// ---------------------------------------------------------------------------

/** Set of deferred tool names that have been activated via tool_search. */
export const activatedTools = new Set<string>();

/**
 * Returns tool definitions suitable for sending to the API.
 * Deferred tools are excluded unless they have been activated.
 * The `deferred` field is stripped from the output.
 */
export function getActiveToolDefinitions(
  allTools?: ToolDef[],
): Omit<ToolDef, "deferred">[] {
  const tools = allTools ?? toolDefinitions;
  return tools
    .filter((t) => !t.deferred || activatedTools.has(t.name))
    .map(({ deferred: _, ...rest }) => rest);
}

/**
 * Returns the names of deferred tools that have NOT yet been activated.
 * Useful for prompt engineering — lets the system prompt list available
 * deferred tools so the model knows what it can search for.
 */
export function getDeferredToolNames(allTools?: ToolDef[]): string[] {
  const tools = allTools ?? toolDefinitions;
  return tools
    .filter((t) => t.deferred && !activatedTools.has(t.name))
    .map((t) => t.name);
}

// ---------------------------------------------------------------------------
// analyze_image — conditionally registered. Returns null (and the tool is
// hidden from the model) when:
//   * no resolvable image-model provider pair, AND
//   * config does NOT explicitly demand an image model
//
// Throws when config explicitly requests an imageModel but the agent
// has no agentDir to land its media/auth state. The implicit case
// (no explicit demand, no agentDir) is silent.
// ---------------------------------------------------------------------------

import { parseModelId, modelHasNativeVision, lookupCapability } from "@/tools/image-models";
import { resolveImageProvider } from "@/tools/image-provider";

export interface ImageToolEnvironment {
  /** Main model in use. Used to pick description wording + native vision check. */
  mainModel: string;
  /**
   * Explicit config request for an image model. Format: "provider/model"
   * or a bare model name we can infer the provider from.
   */
  configuredImageModel?: string;
  /** Agent working directory — required when configuredImageModel is set. */
  agentDir?: string;
}

export interface GatedImageTool {
  tool:     ToolDef;
  /** Resolved (provider, model) pair the handler should use. */
  provider: string;
  model:    string;
}

/**
 * Compute the description text. Switches based on whether the main model
 * already has native vision — that affects whether the tool should
 * encourage the model to use it.
 */
function describeAnalyzeImage(mainModel: string): string {
  if (modelHasNativeVision(mainModel)) {
    return (
      "Analyze one or more images with a vision model. " +
      "Use `image` for a single path/URL, or `images` for multiple (up to 20). " +
      "Only use this tool when images were NOT already provided in the user's " +
      "message. Images mentioned in the prompt are automatically visible to you."
    );
  }
  return (
    "Analyze one or more images with the configured image model " +
    "(agents.defaults.imageModel). Use `image` for a single path/URL, or " +
    "`images` for multiple (up to 20). Provide a prompt describing what to analyze."
  );
}

/**
 * Build the analyze_image tool definition and resolved (provider, model)
 * pair. Returns null when the tool should be hidden.
 *
 * Resolution precedence:
 *   1. explicit `configuredImageModel`           (config demand)
 *   2. main model itself, if it has native vision
 *   3. nothing → return null
 */
export function gateAnalyzeImage(env: ImageToolEnvironment): GatedImageTool | null {
  // Step (a) — config explicitly demanded an image model.
  if (env.configuredImageModel) {
    if (!env.agentDir) {
      throw new Error(
        `analyze_image: configuredImageModel "${env.configuredImageModel}" was ` +
        `requested but no agentDir is configured. Set the agent working directory ` +
        `or remove the imageModel demand.`,
      );
    }
    const parsed = parseModelId(env.configuredImageModel);
    if (!parsed) return null;
    if (!resolveImageProvider(parsed.provider, parsed.model)) return null;
    return {
      tool: {
        name:        "analyze_image",
        description: describeAnalyzeImage(env.mainModel),
        input_schema: ANALYZE_IMAGE_SCHEMA,
      },
      provider: parsed.provider,
      model:    parsed.model,
    };
  }

  // Step (b) — main model has native vision; reuse it without explicit config.
  const cap = lookupCapability(env.mainModel);
  if (cap && cap.vision && resolveImageProvider(cap.provider, env.mainModel)) {
    return {
      tool: {
        name:        "analyze_image",
        description: describeAnalyzeImage(env.mainModel),
        input_schema: ANALYZE_IMAGE_SCHEMA,
      },
      provider: cap.provider,
      model:    env.mainModel,
    };
  }

  // Step (c) — nothing to offer.
  return null;
}

/** Shared input schema for analyze_image. Both fields optional individually. */
export const ANALYZE_IMAGE_SCHEMA = {
  type: "object" as const,
  properties: {
    image: {
      type:        "string",
      description: "Path / URL / data-URL for a single image. Mutually compatible with `images`.",
    },
    images: {
      type:        "array",
      items:       { type: "string" },
      description: "List of paths / URLs / data-URLs (up to 20).",
    },
    prompt: {
      type:        "string",
      description: "Question or instruction for the vision model. Default: \"Describe the image.\"",
    },
  },
};

/** Holds the resolved gating result so the executor can dispatch with it. */
let activeImageTool: GatedImageTool | null = null;

export function setActiveImageTool(g: GatedImageTool | null): void {
  activeImageTool = g;
}

export function getActiveImageTool(): GatedImageTool | null {
  return activeImageTool;
}

// ---------------------------------------------------------------------------
// analyze_pdf — conditionally registered. Same gating contract as the
// image tool: explicit `configuredPdfModel` wins; otherwise fall back to
// the main model if it has native PDF; otherwise hide the tool.
// ---------------------------------------------------------------------------

import { parsePdfModelId, modelHasNativePdf, lookupPdfCapability } from "@/tools/pdf-models";
import { resolvePdfProvider } from "@/tools/pdf-provider";

export interface PdfToolEnvironment {
  /** Main model in use. Used to pick description wording + native capability check. */
  mainModel: string;
  /** Explicit config request for a PDF model. Same format as image: "provider/model" or bare. */
  configuredPdfModel?: string;
  /** Agent working directory — required when configuredPdfModel is set. */
  agentDir?: string;
}

export interface GatedPdfTool {
  tool:     ToolDef;
  provider: string;
  model:    string;
}

const PDF_TOOL_DESCRIPTION =
  "Analyze one or more PDF documents with a model. Supports native PDF " +
  "analysis for Anthropic and Google models, with text/image extraction " +
  "fallback for other providers. Use `pdf` for a single path/URL, or " +
  "`pdfs` for multiple (up to 10). Provide a prompt describing what to analyze.";

/** Shared input schema for analyze_pdf. All fields individually optional. */
export const ANALYZE_PDF_SCHEMA = {
  type: "object" as const,
  properties: {
    pdf: {
      type:        "string",
      description: "Path / URL / data-URL for a single PDF. Mutually compatible with `pdfs`.",
    },
    pdfs: {
      type:        "array",
      items:       { type: "string" },
      description: "List of paths / URLs / data-URLs (up to 10).",
    },
    prompt: {
      type:        "string",
      description: "Question or instruction for the model. Default: \"Describe the PDF.\"",
    },
    pages: {
      type:        "string",
      description: "Page range to process, e.g. \"1-5\", \"1,3,5-7\". Defaults to all pages.",
    },
  },
};

export function gateAnalyzePdf(env: PdfToolEnvironment): GatedPdfTool | null {
  // (a) Explicit config demand.
  if (env.configuredPdfModel) {
    if (!env.agentDir) {
      throw new Error(
        `analyze_pdf: configuredPdfModel "${env.configuredPdfModel}" was ` +
        `requested but no agentDir is configured. Set the agent working directory ` +
        `or remove the pdfModel demand.`,
      );
    }
    const parsed = parsePdfModelId(env.configuredPdfModel);
    if (!parsed) return null;
    if (!resolvePdfProvider(parsed.provider, parsed.model)) return null;
    return {
      tool: { name: "analyze_pdf", description: PDF_TOOL_DESCRIPTION, input_schema: ANALYZE_PDF_SCHEMA },
      provider: parsed.provider,
      model:    parsed.model,
    };
  }

  // (b) Main model has native PDF; reuse it.
  const cap = lookupPdfCapability(env.mainModel);
  if (cap && cap.nativePdf && resolvePdfProvider(cap.provider, env.mainModel)) {
    return {
      tool: { name: "analyze_pdf", description: PDF_TOOL_DESCRIPTION, input_schema: ANALYZE_PDF_SCHEMA },
      provider: cap.provider,
      model:    env.mainModel,
    };
  }

  // (c) Nothing to offer.
  return null;
}

// Touch the helper so eslint/tsc doesn't flag the unused-import warning
// when this file is consumed without the native-pdf check directly.
export { modelHasNativePdf };

let activePdfTool: GatedPdfTool | null = null;

export function setActivePdfTool(g: GatedPdfTool | null): void {
  activePdfTool = g;
}

export function getActivePdfTool(): GatedPdfTool | null {
  return activePdfTool;
}
