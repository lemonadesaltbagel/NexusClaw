import Anthropic from "@anthropic-ai/sdk";
import {
  ContinuationKind,
  DEFAULT_MAX_TOKENS,
  MAX_COMPACT_RETRIES,
  MAX_RECOVERY_RETRIES,
  type ContinuationSignal,
  type LoopFeedback,
  type QueryLoopParams,
  type QueryResult,
} from "@/core/types";

// ---------------------------------------------------------------------------
// queryLoop — async generator handling a single user→assistant turn.
//
// Yields ContinuationSignal at each of the 7 continuation points.
// The caller (QueryEngine) handles the signal, performs side-effects, and
// feeds back LoopFeedback via generator.next(feedback).
// Returns QueryResult when the turn is complete.
// ---------------------------------------------------------------------------

export async function* queryLoop(
  params: QueryLoopParams,
): AsyncGenerator<ContinuationSignal, QueryResult, LoopFeedback> {
  let { messages, maxTokens, model, system, tools, client, checkStopHook } =
    params;

  let hasEscalated = false;
  let recoveryRetries = 0;
  let collapseAttempted = false;
  let compactRetries = 0;
  let withheldError: unknown = null;

  while (true) {
    // ----- API call -----
    let response: Anthropic.Messages.Message;

    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages,
        ...(system !== undefined && { system }),
        ...(tools?.length && { tools }),
      });
    } catch (err: unknown) {
      // ---- Prompt-too-long handling (2-stage, withhold error) ----
      if (isPromptTooLongError(err)) {
        // Withhold the error — recovery logic may handle it silently.
        // Only exposed if all recovery stages are exhausted.
        withheldError = err;

        if (!collapseAttempted) {
          // Stage 1: collapse_drain_retry
          collapseAttempted = true;
          const feedback: LoopFeedback = yield {
            kind: ContinuationKind.CollapseDrainRetry,
          };
          messages = feedback.messages;
          maxTokens = feedback.maxTokens;
          continue;
        }

        // Stage 2: reactive_compact_retry (limited retries)
        if (compactRetries < MAX_COMPACT_RETRIES) {
          compactRetries++;
          const feedback: LoopFeedback = yield {
            kind: ContinuationKind.ReactiveCompactRetry,
          };
          messages = feedback.messages;
          maxTokens = feedback.maxTokens;
          continue;
        }

        // Recovery exhausted — expose the withheld error
        throw withheldError;
      }

      // Non-PTL errors propagate to the engine
      throw err;
    }

    // ----- Dispatch on stop_reason -----
    switch (response.stop_reason) {
      // ---- 1. next_turn: model wants to use a tool ----
      case "tool_use": {
        const feedback: LoopFeedback = yield {
          kind: ContinuationKind.NextTurn,
          response,
        };
        messages = feedback.messages;
        maxTokens = feedback.maxTokens;
        // Reset PTL stage for the new sub-turn
        collapseAttempted = false;
        continue;
      }

      // ---- 4 & 5. max_tokens: output truncation ----
      case "max_tokens": {
        // First truncation → escalate (16K → 64K)
        if (!hasEscalated && maxTokens < DEFAULT_MAX_TOKENS * 4) {
          hasEscalated = true;
          const feedback: LoopFeedback = yield {
            kind: ContinuationKind.MaxOutputTokensEscalate,
            response,
          };
          messages = feedback.messages;
          maxTokens = feedback.maxTokens;
          continue;
        }

        // Subsequent truncations → recovery via continuation prompt (≤3×)
        if (recoveryRetries < MAX_RECOVERY_RETRIES) {
          recoveryRetries++;
          const feedback: LoopFeedback = yield {
            kind: ContinuationKind.MaxOutputTokensRecovery,
            response,
            retryCount: recoveryRetries,
          };
          messages = feedback.messages;
          maxTokens = feedback.maxTokens;
          continue;
        }

        // Exhausted all recovery attempts — return truncated result
        return { response, messages };
      }

      // ---- 7. pause_turn: API-side token budget exhausted ----
      case "pause_turn": {
        const feedback: LoopFeedback = yield {
          kind: ContinuationKind.TokenBudgetContinuation,
          response,
        };
        messages = feedback.messages;
        maxTokens = feedback.maxTokens;
        continue;
      }

      // ---- end_turn: natural completion (may be blocked by stop hook) ----
      case "end_turn":
      case "stop_sequence":
      default: {
        // ---- 6. stop_hook_blocking: hook says "not done yet" ----
        if (checkStopHook && (await checkStopHook(response))) {
          const feedback: LoopFeedback = yield {
            kind: ContinuationKind.StopHookBlocking,
            response,
          };
          messages = feedback.messages;
          maxTokens = feedback.maxTokens;
          continue;
        }

        // Turn genuinely complete
        return { response, messages };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPromptTooLongError(err: unknown): boolean {
  if (err instanceof Anthropic.BadRequestError) {
    const msg = String(err.message).toLowerCase();
    return msg.includes("prompt is too long") || msg.includes("prompt_too_long");
  }
  return false;
}
