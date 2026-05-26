// ---------------------------------------------------------------------------
// Verbose-log helper for the Telegram adapter.
//
// Dumps a grammY Update with truncation so noisy fields (long text bodies,
// big arrays) don't flood the log. Pure: no I/O at module load, no global
// state, and the input value is never mutated.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_STRING_LEN = 500;
export const DEFAULT_MAX_ARRAY_LEN = 20;

export interface TruncateOptions {
  maxStringLen?: number;
  maxArrayLen?: number;
}

/**
 * Walk an object tree, returning a structurally cloned copy with:
 *   - strings longer than maxStringLen suffixed by `… (<N> more chars)`
 *   - arrays longer than maxArrayLen sliced to the first N + `[+<M> more]`
 * Primitives are returned unchanged. Cycles are short-circuited.
 */
export function truncateForLog(value: unknown, opts: TruncateOptions = {}): unknown {
  const maxStringLen = opts.maxStringLen ?? DEFAULT_MAX_STRING_LEN;
  const maxArrayLen = opts.maxArrayLen ?? DEFAULT_MAX_ARRAY_LEN;
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= maxStringLen) return v;
      return v.slice(0, maxStringLen) + `… (${v.length - maxStringLen} more chars)`;
    }
    if (Array.isArray(v)) {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (v.length <= maxArrayLen) return v.map(walk);
      return [...v.slice(0, maxArrayLen).map(walk), `[+${v.length - maxArrayLen} more]`];
    }
    if (v !== null && typeof v === "object") {
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v)) out[k] = walk(vv);
      return out;
    }
    return v;
  };

  return walk(value);
}

/** Emit one verbose log line for a raw grammY Update. */
export function verboseLogUpdate(update: unknown, opts: TruncateOptions = {}): void {
  const safe = truncateForLog(update, opts);
  console.error("[telegram:verbose]", JSON.stringify(safe));
}
