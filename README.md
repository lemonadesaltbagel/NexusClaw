# NexusCode

A production-shaped CLI coding agent. Provider-agnostic across Anthropic and OpenAI, with a single-loop control core, multi-tier context compression, speculative tool execution, sub-agents, MCP, and a permission system designed for use in real engineering workflows — not a toy demo.

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **[Bun](https://bun.com)** | Native TS execution, built-in test runner, fast IO, no transpile step |
| Language | **TypeScript** (strict) | Fully typed agent core, including SDK message types |
| LLM SDKs | **`@anthropic-ai/sdk`**, **`openai`** | Dual-provider — same agent core drives both |
| CLI | **`commander`** | Argument parsing, subcommands, help text |
| Schema | **`zod`** | Runtime validation at tool boundaries |
| Style | **`chalk`** | TTY-aware terminal styling |
| Tests | **`bun:test`** | 26 suites, 400+ tests, no external test framework |
| External tools | **MCP** (Model Context Protocol) over stdio + JSON-RPC 2.0 | Standard interop with third-party tool servers |

No build step, no bundler, no transpiler. `bun run src/index.ts` is the entry point.

---

## Architecture at a Glance

The agent is a **single class driving a single `while(true)` loop** (`src/core/agent.ts:524`). One iteration = one API round-trip + zero-or-more tool executions. Every behavior — streaming, retries, compression, sub-agents, plan mode, permissions — is layered onto that loop, not bolted on as parallel state machines.

```
chat(userMessage)
  └─ runTurn()
       ├─ start memory prefetch  (non-blocking side query)
       └─ loop:
            1. poll memory prefetch → inject if ready
            2. compression pipeline  (Tier 1 → 2 → 3)
            3. provider.createMessage()  (streaming)
                 ├─ on text delta  → stdout
                 └─ on tool_use    → speculative early execution
            4. dispatch on stop_reason:
                 ├─ tool_use   → handleNextTurn → loop
                 ├─ max_tokens → escalate / recover → loop
                 ├─ pause_turn → continuation     → loop
                 └─ end_turn   → return
```

A standalone visualization of this loop is checked in as [`agent-loop.html`](./agent-loop.html).

---

## What the Agent Actually Does

### 1. Provider-agnostic core

A single `Provider` interface (`src/core/provider.ts`) hides Anthropic vs. OpenAI behind one `createMessage()` call. The Agent class never imports vendor SDKs directly — switching backends is a constructor argument, not a fork.

### 2. Streaming-time speculative tool execution

When a tool_use block arrives during streaming, if the tool is in `CONCURRENCY_SAFE_TOOLS` *and* passes `checkPermission()`, it starts executing **before the model finishes its response** (`src/core/agent.ts:585-595`). Results are awaited at dispatch time. This shaves real wall-clock latency on read-heavy turns without speculating on risky operations.

### 3. Parallel tool batching with permission gates

`handleNextTurn` groups consecutive concurrency-safe + allowed tool blocks into parallel `Promise.all` batches (`src/core/agent.ts:716-727`); non-safe tools fall back to serial execution through `checkPermission` with ask / deny / confirm-dangerous paths. Maximum parallelism, zero correctness regression.

### 4. Three-tier context compression

Long-running sessions degrade gracefully instead of crashing on prompt-too-long errors:

| Tier | Trigger | Action |
|---|---|---|
| 1. `budgetToolResults` | >50% context utilization | Cap individual tool results at 15–30 KB (head + tail) |
| 2. `snipStaleResults` | >60% utilization | Dedup `read_file` per path, keep last 3 search results per tool type, protect newest 3 unconditionally |
| 3. `microcompact` | ≥5 min idle since last API call | Clear stale tool_result content while preserving tool_use metadata |
| Reactive | Caught `prompt_too_long` | `collapseDrain` once, then `reactiveCompact` up to 3× before surfacing the error |
| Proactive | >85% utilization | `checkAndCompact` summarizes history through a dedicated compaction prompt |

### 5. Sub-agents (delegation, not just chat)

The `agent` tool spawns an isolated `Agent` instance with a restricted tool set (`getSubAgentConfig`, `src/core/subagent.ts`). Three roles: `explore` (read-only research), `plan` (architecture design), `general` (full-tool delegation). Sub-agent text is buffered, not streamed to the parent — the parent only sees the final summary, protecting its context window. Token usage rolls back up to the parent for accurate cost accounting.

### 6. MCP client (Model Context Protocol)

Full stdio + JSON-RPC 2.0 client in `src/core/mcp.ts`: spawns external tool servers, runs the `initialize` handshake, lists their tools, namespaces them as `mcp__<server>__<tool>`, and routes calls back. Idempotent lifecycle so reconnects don't double-spawn.

### 7. Skills (filesystem-discovered slash commands)

`/<skill-name> [args]` resolves to a prompt template loaded from disk at startup (`src/core/skills.ts`). Skills can be user-invocable (typed by the user) or model-invocable (selected by the LLM via the `skill` tool). Argument substitution is template-based, not eval-based.

### 8. Plan mode

`enter_plan_mode` switches the permission mode to plan, swaps in a read-only tool set + planning system prompt, and writes the resulting plan to `~/.claude/plans/`. Exit via approval routes the plan back to the user with execute / clear-and-execute / manual / keep-planning choices. Pre-plan permission mode is restored on exit.

### 9. Memory with non-blocking side-query

Per-project memory directory with frontmatter-typed entries (user / feedback / project / reference). On each turn, a **lightweight side-query LLM call** runs in parallel with the main API call to pick relevant memories (`startMemoryPrefetch`, `src/core/memory.ts:418`). Results are injected only if they arrive in time — never blocks the critical path. Already-surfaced memories are tracked to prevent re-injection.

### 10. Recovery semantics

| Failure | Strategy |
|---|---|
| Transient API error | `withRetry` with backoff (`src/core/retry.ts`) |
| `prompt_too_long` | 2-stage compression with error withheld until recovery exhausted |
| `max_tokens` | First: escalate `max_tokens` 16K → 64K. Then: up to 3 continuation prompts |
| `pause_turn` | Continuation prompt, preserves partial output |
| User Ctrl-C | `AbortController` propagates through provider, retry, and tool execution |
| Stop hook block | `checkStopHook` can refuse end_turn and force the model to continue |

---

## Designs That Matter in Real Business Use

These are the choices that separate a demo agent from one you'd actually deploy.

### Two-stage error withholding for context overflow

When the provider returns `prompt_too_long`, the agent does **not** surface the error to the user immediately. It captures it as `withheldError`, runs `handleCollapseDrain`, retries; if that fails, runs `handleReactiveCompact` up to 3 times. Only if *all* recovery stages fail does the original error propagate. The user sees seamless continuation on what would otherwise be a turn-killing fault.

**Why it matters:** in production, the most common cause of user churn from agent tools is a single bad turn killing a session that has hours of accumulated state. Recovery has to be invisible.

### Permission modes are policy, not UI

Five orthogonal modes (`default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`) compose with allow/deny rules loaded from `~/.claude/settings.json` and `<project>/.claude/settings.json` (`src/tools/dangerous.ts`). Tool rules support exact-match and prefix-glob patterns (e.g. `run_shell(git status*)`). Dangerous shell command detection runs **independently** of the rule engine — a pattern match on `rm`, `sudo`, `git push`, etc. forces a confirm even if the user added a broad allow rule, unless they're explicitly in `bypassPermissions`.

**Why it matters:** business deployments need fleet-wide policy + per-user overrides + a safety net the user can't accidentally disable. This is exactly that shape.

### Large tool results spill to disk with previews

Tool results larger than 30 KB are written to `~/.mini-claude/tool-results/<timestamp>-<tool>.txt` and replaced inline with a 200-line preview + the on-disk path (`persistLargeResult`, `src/core/agent.ts:831`). The model can re-`read_file` the full result if it needs more.

**Why it matters:** a single 5 MB grep result will otherwise blow the context window in one turn. This design treats the conversation as a working set, with cold storage one tool call away — the same pattern you'd use for paging in a database engine.

### Cost & turn caps as first-class CLI flags

`--max-cost <dollars>` and `--max-turns <n>` are wired into the agent loop, not bolted on as wrappers. Token usage is accumulated per turn (`totalInputTokens`, `totalOutputTokens`) including sub-agent rollup, then compared against the cap before each API call.

**Why it matters:** every team that has shipped an LLM-backed product has been bitten by a runaway-loop bill. Putting this in the core, not the wrapper, means it survives refactors.

### Session persistence with explicit `--resume`

Top-level agents auto-save after each turn (`autoSave`, `src/core/agent.ts:243`); sub-agents do not (`src/core/agent.ts:435`). Sessions are addressable by ID and resumable via the CLI. The `isSubAgent` flag is the only thing gating this — no accidental save spam from delegation.

**Why it matters:** users expect Ctrl-C to be safe and "open it again tomorrow" to just work. Sub-agents creating dozens of phantom sessions is a real bug to design around.

### Memory is async, prompt-time injection — not retrieval at startup

Memories are selected per-turn by an LLM side-query against the user's actual message, with the prefetch running concurrently with the main API call and a deadline that lets the turn proceed without it. Already-surfaced memories are de-duplicated within a session.

**Why it matters:** static RAG at startup floods the system prompt with irrelevant context. Per-turn semantic selection keeps the prompt tight and the relevance high — at the cost of one cheap LLM call per turn, which often overlaps the main call entirely.

### Provider abstraction lets enterprise customers swap backends

Adding a new provider means implementing one `createMessage()` method. Anthropic streaming format is canonical internally; the OpenAI provider translates both directions including delta accumulation for fragmented tool-call arguments (`src/core/providers/openai.ts`).

**Why it matters:** enterprise contracts often dictate which LLM vendor is approved. A coupled-to-Anthropic agent is a lost deal.

---

## Quick Start

```bash
bun install

# Interactive REPL
bun run src/index.ts

# One-shot prompt
bun run src/index.ts --prompt "review the diff in src/core/agent.ts"

# Resume the last session
bun run src/index.ts --resume

# With cost cap
bun run src/index.ts --max-cost 0.50 --max-turns 20
```

Set `ANTHROPIC_API_KEY` (default) or `OPENAI_API_KEY` + `--api-base` for OpenAI-compatible endpoints.

---

## Project Layout

```
src/
├── index.ts                    # CLI entry
├── cli/
│   ├── commands.ts             # commander definitions
│   ├── repl.ts                 # interactive loop
│   └── ui.ts                   # terminal rendering
├── core/
│   ├── agent.ts                # the single-loop core (1100+ LOC, fully typed)
│   ├── provider.ts             # vendor-agnostic interface
│   ├── providers/{anthropic,openai}.ts
│   ├── memory.ts               # per-project memory with async injection
│   ├── session.ts              # JSON session persistence
│   ├── skills.ts               # filesystem-discovered slash commands
│   ├── subagent.ts             # explore / plan / general roles
│   ├── mcp.ts                  # MCP stdio + JSON-RPC client
│   ├── prompt.ts               # CLAUDE.md + rules + context assembly
│   ├── retry.ts                # exponential backoff with abort
│   └── types.ts                # shared SDK / agent types
└── tools/
    ├── definitions.ts          # JSON schemas + activation gating
    ├── executor.ts             # dispatch
    ├── dangerous.ts            # permission rules + danger patterns
    └── handlers/               # one file per tool
```

---

## Tests

```bash
bun test
```

26 test files. Coverage includes: streaming delta accumulation, parallel tool batching, permission rule matching, compression tiers, sub-agent isolation, MCP lifecycle, memory CRUD + index sync, plan mode transitions, and provider format translation.
