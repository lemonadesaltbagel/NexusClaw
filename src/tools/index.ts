import type { z } from "zod";
import type {
  ToolContext,
  ToolDescriptionOptions,
  ToolInputJSONSchema,
  ToolProgressData,
  ToolRenderOptions,
  PermissionResult,
} from "@/core/types";

// ---------------------------------------------------------------------------
// ToolResult — the value returned by a tool's `call()` method.
// Generic over the output payload so each tool can type its own result shape.
// ---------------------------------------------------------------------------

export interface ToolResult<Output = unknown> {
  /** Structured output forwarded to the model as the tool_result content. */
  output: Output;
  /** If true the result represents an error (model sees it as an error). */
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Tool — the full behavioral contract every tool must satisfy.
//
// Generic parameters:
//   Input  — Zod schema type (used for both runtime validation & TS inference)
//   Output — the structured value returned by `call()`
//   P      — progress data shape emitted via the `onProgress` callback
// ---------------------------------------------------------------------------

export interface Tool<
  Input extends z.ZodType = z.ZodType,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> {
  /** Canonical name used in API tool_use blocks. */
  name: string;

  /** Deprecated aliases kept for smooth migration (old names still dispatch here). */
  aliases?: string[];

  /** If a single tool result exceeds this size it is persisted to disk and a pointer is returned instead. */
  maxResultSizeChars: number;

  // ---- Execution ----

  /** Execute the tool. */
  call(
    /** Validated input (inferred from `inputSchema`). */
    args: z.infer<Input>,
    /** Environmental context (cwd, messages, signal …). */
    context: ToolContext,
    /** Check whether another tool is available by name (for tool-to-tool delegation). */
    canUseTool: (name: string) => boolean,
    /** The assistant message that triggered this tool use (for context / auditing). */
    parentMessage: unknown,
    /** Optional progress callback streamed to the UI during long-running operations. */
    onProgress?: (data: P) => void,
  ): Promise<ToolResult<Output>>;

  // ---- Descriptions injected into the API request ----

  /** Tool description sent to the API alongside the JSON schema (may vary by input). */
  description(
    input: z.infer<Input> | undefined,
    options: ToolDescriptionOptions,
  ): Promise<string>;

  /** Usage guide injected into the system prompt so the model knows *how* to use this tool well. */
  prompt(options: ToolDescriptionOptions): Promise<string>;

  // ---- Schema ----

  /** Zod schema — source of truth for runtime validation *and* TypeScript type inference. */
  inputSchema: Input;

  /**
   * Optional pre-computed JSON Schema sent directly to the Anthropic API.
   * When omitted the host derives it from `inputSchema` via zod-to-json-schema.
   */
  inputJSONSchema?: ToolInputJSONSchema;

  // ---- Safety semantics (input-dependent) ----

  /** Whether this tool can safely run concurrently with other tool calls sharing the same turn. */
  isConcurrencySafe(input: z.infer<Input>): boolean;

  /** Whether this invocation is a pure read with no side effects. */
  isReadOnly(input: z.infer<Input>): boolean;

  /** Whether this invocation is destructive (e.g. `rm -rf`, `DROP TABLE`). */
  isDestructive?(input: z.infer<Input>): boolean;

  /** Check whether the current permission policy allows this invocation. */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolContext,
  ): Promise<PermissionResult>;

  // ---- Rendering ----

  /** Render the tool_use block shown to the user while the tool is executing or after completion. */
  renderToolUseMessage(
    input: z.infer<Input>,
    options: ToolRenderOptions,
  ): unknown; // React.ReactNode — kept as `unknown` to avoid coupling to a specific React version

  /** Render the tool_result block shown to the user. */
  renderToolResultMessage?(
    content: Output,
    progress: P | undefined,
    options: ToolRenderOptions,
  ): unknown; // React.ReactNode
}

// ---------------------------------------------------------------------------
// buildTool — factory with fail-closed defaults.
//
// Every safety predicate defaults to the *restrictive* direction:
//   isConcurrencySafe → false   (not safe to run concurrently)
//   isReadOnly         → false   (assumed to have write side effects)
//   isDestructive      → false   (not destructive — note: destructive ⊂ !readOnly)
//   checkPermissions   → allow   (no extra permission gate beyond the above)
//
// This means forgetting to override a predicate can only make the tool *more*
// restricted than intended (extra permission prompts), never *less* restricted
// (silent concurrent writes). Fail-closed by design.
// ---------------------------------------------------------------------------

/** Partial spec: everything except the fields that have safe defaults. */
export type ToolSpec<
  Input extends z.ZodType = z.ZodType,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<
  Tool<Input, Output, P>,
  | "isConcurrencySafe"
  | "isReadOnly"
  | "isDestructive"
  | "checkPermissions"
  | "renderToolResultMessage"
> &
  Partial<
    Pick<
      Tool<Input, Output, P>,
      | "isConcurrencySafe"
      | "isReadOnly"
      | "isDestructive"
      | "checkPermissions"
      | "renderToolResultMessage"
    >
  >;

const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false as const,
  isReadOnly: () => false as const,
  isDestructive: () => false as const,
  checkPermissions: async () =>
    ({ behavior: "allow" }) as PermissionResult,
} as const;

/**
 * Build a fully-specified `Tool` from a partial spec, filling in
 * fail-closed defaults for any omitted safety/permission methods.
 */
export function buildTool<
  Input extends z.ZodType,
  Output,
  P extends ToolProgressData,
>(spec: ToolSpec<Input, Output, P>): Tool<Input, Output, P> {
  return {
    ...TOOL_DEFAULTS,
    ...spec,
  };
}
