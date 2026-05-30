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

## Remote-Control Layer: From Terminal to Chat Platforms

Beyond the terminal REPL, NexusClaw can be driven from chat platforms (Telegram first; Slack / Discord / web designed-in but not yet shipped). The whole second half of this codebase is a careful answer to one question: **how do you let a generic agent core talk to many platforms without polluting either side with the other's concerns?**

The answer is a **three-layer split** with a strict normalize/denormalize seam at each end.

```
┌──────────────────────────────────────────────────────────────┐
│  PLATFORM ADAPTERS                                           │
│  Telegram (shipped) │ Slack │ Discord │ Web │ CLI            │
│  Native API ←→ normalized RemoteEvent / OutboundPayload      │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│  GATEWAY  (transport-agnostic)                               │
│  Auth · per-identity FIFO · agent binding · slash dispatch   │
│  permission bridge · turn lifecycle                          │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│  AGENT CORE  (unchanged)                                     │
│  Agent.chat() · tools · sessions · MCP · skills              │
└──────────────────────────────────────────────────────────────┘
```

The agent core never imports anything from the remote layer. The remote layer never imports anything from the agent core except its public interface. Two-way decoupling by construction.

### Philosophy: normalize on inbound, denormalize on outbound

The agent doesn't know what Telegram is. It doesn't know what a "forum topic" is. It doesn't know what `parse_mode: "HTML"` means. It receives plain strings, emits plain strings, and the conversion to and from any platform's actual wire format is **the adapter's job**.

This isn't a soft preference — it's the load-bearing decision the rest of the layer rests on:

| Direction | Adapter's responsibility |
|---|---|
| **Inbound** (platform → agent) | Take whatever bizarre shape the platform gives you and reduce it to a `RemoteEvent` the agent can handle without knowing where it came from. |
| **Outbound** (agent → platform) | Take the agent's platform-neutral `OutboundPayload` and rebuild it into the platform's exact wire format, including all the quirks the agent shouldn't care about. |

Below, the actual mechanics of how each direction works.

---

### Inbound: making the message truly generic for the agent core

**The problem.** Telegram's `Update` object is a 60-field union covering messages, edits, callback queries, polls, chat-member changes, business connections, paid subscriptions… The agent core wants to receive *"user X said Y in conversation Z"*. The distance between those two shapes is where bugs live.

**The resolution.** The Telegram adapter normalizes every inbound update through a fixed pipeline before the gateway ever sees it. Each stage either translates, filters, gates, or drops — by the time something arrives at the agent it's a `RemoteEvent` that any platform could have produced.

```
grammY long-poll
  │
  ▼  Middleware (1) — verbose log, dedup, sequentialize
  │
  ▼  Subscription filter (2)
  │    "message"          → handler below
  │    "edited_message"   → no-op (intentionally invisible — by design)
  │    "my_chat_member"   → log (operator awareness)
  │    "callback_query"   → access-gated, resolves pending prompts
  │
  ▼  Self-message drop (3)         ← skip messages the bot itself sent
  │
  ▼  Chat classification (4)       ← private / group / forum / channel
  │
  ▼  Access checks (5)             ← group policy / DM policy / pairing
  │
  ▼  Text extraction (6)           ← message.text OR message.caption
  │
  ▼  Empty / mention strip (7)     ← /cmd@otherbot dropped; /cmd@us → /cmd
  │
  ▼  FloodGuard (8)                ← rate-limit, queue cap, debounce
  │
  ▼  Synthetic message (9)         ← burst of small messages → one
  │
  ▼  RemoteEvent.message            ← what the agent finally sees
```

What survives at the bottom is **the same shape regardless of platform**:

```
RemoteEvent.message = {
  from:    { platform: "telegram", userId: "555111222", chatId: "-1001",
             topicId?: "42",  messageId: 12345 },
  text:    "the user's actual request",
  signal?: AbortSignal       // gateway can cancel mid-turn
}
```

Compare what came in to what comes out:

- **What the platform sent**: 60 possible fields, possibly several updates within 2 seconds, possibly containing media with a text caption, possibly a slash-command with an `@botname` suffix, possibly the bot's own echoed message, possibly an edit of an old message.
- **What the agent receives**: one normalized object with stable field names, exactly one event per user intent. The agent can treat it the same way it treats input from a Slack bot or a web form.

The middleware-then-handler structure is the same shape the existing REPL uses. The agent didn't need to learn anything new to be talked to over Telegram.

---

### Outbound: making the message meaningful for the platform

**The problem.** The agent wants to say *"Done! I updated **README.md** and pushed."* — markdown with bold text. Telegram doesn't render markdown; it renders a specific HTML subset with strict tag rules, a 4096-character cap per message, mandatory `parse_mode: "HTML"`, optional inline keyboards as a 2-D button array, and a quirky reply-quote system that requires you to know the parent message id.

**The resolution.** The agent emits one platform-neutral `OutboundPayload`:

```
{
  text: "Done! I updated **README.md** and pushed.",
  interactive?: { blocks: [...] },
  channelData?: { telegram?: { quoteText?: "..." } },
  mediaUrls?:    [...],
  forceDocument?: boolean,
  silent?:       boolean
}
```

The `OutboundTarget` routes it:

```
{ channel: "telegram", to: "-1001234567890", threadId: "-1001:topic:42", replyToId: 555 }
```

The router picks the right adapter by `channel`. The adapter denormalizes:

```
OutboundPayload + OutboundTarget
  │
  ▼  (1) markdown → Telegram HTML
  │      **README.md** becomes <b>README.md</b>
  │      `pnpm test`  becomes <code>pnpm test</code>
  │      < > & in user text are escaped first; tags get inserted second
  │
  ▼  (2) chunk into ≤ 4000-char pieces
  │      tags that straddle a split are closed at the end of chunk N
  │      and reopened at the start of chunk N+1 — attributes preserved
  │
  ▼  (3) build wire-level options
  │      threadId "-1001:topic:42" → message_thread_id: 42
  │      interactive.blocks        → InlineKeyboardMarkup (3 buttons / row)
  │      channelData.telegram.inlineKeyboard wins if present (full 2-D)
  │      replyToId + quoteText     → reply_parameters { message_id, quote }
  │      replyToId only            → reply_to_message_id (older shape)
  │      silent: true              → disable_notification: true
  │
  ▼  (4) iterate chunks / media
  │      first chunk carries the keyboard + quote
  │      subsequent chunks are continuations only
  │      media: first item carries text as caption + keyboard; rest media-only
  │      forceDocument routes sendPhoto → sendDocument
  │
  ▼  (5) Bot API call(s)
```

What the agent wrote vs. what the bot sent over the wire:

- **What the agent emitted**: `{ text: "Done! ..." }` — markdown, no parse mode, no message id awareness.
- **What hit the Bot API**: one `sendMessage` call with HTML-escaped body, `parse_mode: "HTML"`, `message_thread_id: 42`, `reply_parameters: { message_id: 555, quote: "...", quote_parse_mode: "HTML" }`, and (if buttons were requested) a 2-D `reply_markup.inline_keyboard`.

The agent stays in plain markdown. Every Telegram-specific quirk lives inside one file.

---

### The carrier: how information survives the stream

Some information needs to travel through the entire round trip — captured on inbound, used on outbound. A `RemoteIdentity` is the carrier:

```
RemoteIdentity = {
  platform:  "telegram",
  userId:    "555111222",     // who
  chatId:    "-1001",         // where
  topicId?:  "42",            // sub-channel (forum / Slack thread)
  messageId?: 12345           // the inbound message id
}
```

**`messageId` example.** When a user sends *"can you summarize this?"* in Telegram, the adapter captures `ctx.message.message_id`. That number rides along on the `RemoteIdentity`. When the agent eventually replies, the gateway threads the same id into the outbound `OutboundTarget.replyToId`. The Telegram adapter combines it with any `channelData.telegram.quoteText` to produce a real `reply_parameters` block — meaning the bot's reply visually links to the user's original message, with an excerpt quoted above it. The agent never had to know any of that machinery existed; it just received text and emitted text.

**`topicId` example.** In a forum-enabled supergroup, the user posts inside the topic *"Dev Discussion"*. The adapter parses `ctx.message.message_thread_id` and stores it on the identity. On the outbound side, `target.threadId` arrives encoded as `"<chatId>:topic:<topicId>"` — a deliberately string-shaped composite — and the adapter parses the trailing integer back out into `message_thread_id`. The bot's reply lands in the same topic instead of leaking into the general channel.

**`channelData` example.** Some richness genuinely doesn't generalize. Telegram's `quoteText` doesn't have a Slack analog. Slack's `blocks` don't have a Telegram analog. Forcing the platform-neutral types to accept either would either bloat them or block them. So the payload exposes a per-platform escape hatch:

```
{ channelData: { telegram: { quoteText: "...", inlineKeyboard: [[...]] } } }
```

Adapters check `channelData.<their-name>` for platform-specific overrides. For Telegram, an explicit `inlineKeyboard` (a real 2-D `InlineKeyboardButton[][]` with full callback-data and URL-button freedom) **wins over** the cross-platform `interactive.blocks` — the override path. Both can coexist; the adapter picks the more specific one when both are present.

**Media example.** The agent emits `{ mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"] }` alongside its text. A shared helper iterates: first media item gets the text as a caption *and* the inline keyboard; subsequent items are media-only. Switching `sendPhoto` to `sendDocument` is a single boolean (`forceDocument`) instead of a separate type taxonomy — sending an image "uncompressed as a file" is a flag, not a kind. The agent thinks "here's some media plus a caption"; the wire ends up with multiple correctly-attributed API calls.

---

### Safety nets: failure modes met with paired backup data

Real chat platforms fail in non-obvious ways. A well-formed message gets rejected because one character of escaping was wrong. A topic was deleted while the bot was composing. The bot was rate-limited because it sent 3 chunks too fast. The retry strategy has to be specific to each failure or it does nothing.

**The HTML + plain text pair.** The biggest safety net is the one hiding in plain sight: the chunker doesn't just produce one chunk — it produces a `[{ htmlText, plainText }]` pair for every chunk. The HTML version is what the bot tries first. The plain version is held in reserve. If Telegram's parser rejects the HTML (one tag was malformed, one entity wasn't escaped right, one URL had a stray bracket), the adapter retries the **same chunk** as `plainText` with `parse_mode` dropped. The user sees a less-formatted reply instead of nothing.

```
First attempt:  text = "<b>Done!</b> Updated <code>README.md</code>"
                parse_mode = "HTML"
                → API returns "can't parse entities: …"

Safety net:     text = "Done! Updated README.md"
                parse_mode = (omitted)
                → API accepts
```

The same chunker produces both. The plain text isn't reconstructed at retry time — it was computed up front and kept in the pair so the retry path is just a different field access. The whole approach is *"don't lose data at the point you might need it later"*.

**The thread-not-found pivot.** Forum topics can be deleted by moderators while the bot is mid-turn. The bot is holding the (now-stale) `message_thread_id`. Telegram returns *"message thread not found"*. The adapter catches that specific error, retries the same chunk without the `message_thread_id`, and the message falls into the chat's General topic instead of vanishing.

**The 429 backoff.** Telegram rate-limits a bot to ~30 messages per second globally and ~1 per second per chat. When the adapter sends multiple chunks for one long reply, it eventually triggers a 429 with a `retry_after` hint. The adapter sleeps for exactly that long (capped at 60s), then retries. The agent has no idea this happened.

**The retry safety net stack** (in `sendChunkWithRetries`):

| Error from Telegram | What the adapter does |
|---|---|
| `can't parse entities` | Retry with `chunk.plainText`, no `parse_mode` |
| `message thread not found` | Retry without `message_thread_id` |
| `429 Too Many Requests` | Sleep `retry_after` seconds, then retry |
| Anything else | Rethrow — let the caller see it |

Plus a 50ms inter-chunk delay when sending a multi-chunk reply, to stay below the per-chat throttle in the first place.

**Inbound has its own safety net stack.** Different failures, same principle of "fail soft, log loud":

| Inbound problem | Defense |
|---|---|
| Network re-delivers an update | `pendingUpdateIds` dedup before the handler runs |
| Concurrent updates race | `Sequentializer` serializes the inbound handler stack |
| Update of an unsupported type | Subscribed-but-empty `bot.on("edited_message", () => {})` so grammY pulls it from the wire, then drops |
| User sends 30 short messages in 1 second | `FloodGuard` debounces them into one synthetic message |
| User crosses 120 messages / minute | 429 reject with no reply (operator log only) |
| User has 8 messages waiting for response | 429 reject (queue depth cap) |
| Turn is wedged with no `turn_done` | Per-turn `AbortController` + janitor sweep cancels and frees the slot |
| Abuser keeps offending | Abuse counter persists across restarts; warns the operator every 25 events |

---

### Notable architecture choices in the remote layer

Beyond the inbound/outbound seam itself, a handful of decisions matter enough to call out individually. Each took several discussion rounds to settle and each came directly from a real issue rather than a design preference.

#### Per-identity FIFO queue in the gateway

**The issue.** Two users talking to the bot at the same time should run in parallel — they're different conversations. The same user sending two messages in quick succession should serialize — the second message might depend on the first having completed.

**The resolution.** The gateway holds an `IdentityQueue` keyed by canonical user id. Different users get different lanes (parallel agent.chat); the same user always goes through one lane (strict FIFO). Mirrors the REPL's `rl.once` invariant without inheriting its single-user limitation.

#### Two-pipeline outbound: preview + delivery

**The issue.** A live-thinking effect (text appearing letter by letter as the agent streams) is a different UX from durable announcements (tool calls, system notices, the final reply). Bolting both into one path produces broken behavior — either no streaming or noise from re-edits of finalized messages.

**The resolution.** Two pipelines coexist:

- **Preview pipeline** — a `DraftStream` per `(chatId, threadId)` that the user sees grow delta by delta. Implemented as `sendMessage` for the first delta, then `editMessageText` for subsequent ones, throttled to one edit per 500ms to stay under per-chat rate limits.
- **Delivery pipeline** — discrete, durable messages built via the full `sendPayload` path. Used for tool announcements, tool results, system notices, and the final assistant reply.

A `Coordinator` owns both pipelines and routes the agent's callbacks (`onText` / `onToolCall` / `onToolResult` / `system` / `turn_done`) to the right one. **The agent doesn't know streams exist** — it just calls callbacks; the coordinator decides whether the callback grows the live draft or materializes the draft and emits a delivery payload.

The DraftStream itself is a small interface with explicit verbs:

| Verb | Meaning |
|---|---|
| `update(delta)` | Extend the live bubble |
| `flush()` | Commit current state to the bubble now |
| `materialize()` | Finalize the draft as a permanent message |
| `forceNewMessage()` | Next update opens a fresh bubble |
| `clear()` / `stop()` | Drop in-flight tracking without deleting the rendered message |

**The adapter remembers the messageId internally** — callers never touch it. Cleaner than "the previous one is close enough in time" implicit edit semantics that other bots tend to drift toward.

#### Per-turn AbortController + janitor

**The issue.** A wedged turn (agent hangs in a tool call, network call doesn't return) would leave a pending slot occupied forever. After eight wedged turns the user is locked out permanently and the operator only finds out when complaints arrive.

**The resolution.** Every turn gets its own `AbortController`. The signal flows through every layer that takes an `await`:

```
FloodGuard.dispatchOne  →  adapter.onFlush  →  RemoteEvent  →
gateway.dispatch  →  agent.chat(text, { signal })  →
Agent's internal abortController (chained with the external signal) →
provider.createMessage / tool execution / retry sleep
```

A `setInterval(60_000)` janitor scans the in-flight map. Any entry past its deadline gets `controller.abort()` called on it. The abort propagates back through the awaits, lands in `dispatchOne`'s `try/finally`, releases the slot. **The decrement lives in a `finally` block; the `turn_done` log handler is log-only** — release ownership is unambiguous. The operator sees `408 turn timeout` in the log, the user can talk again.

#### Bounded in-memory state, persisted abuse counts

**The issue.** A long-running `serve` process accumulates state for every user who has ever sent a message. Pure in-memory state grows unbounded. Pure on-disk state is slow and adds I/O to the hot path.

**The resolution.** Hot state stays in memory and decays naturally (debounce buffers expire after 2s, rate-window timestamps expire after 60s, in-flight slots release on turn_done). Idle senders are evicted from the in-memory map on each janitor sweep. The one piece of state that needs to survive eviction — the **abuse counter** — is persisted to a small JSON file. An attacker can't reset their score by going quiet for 5 minutes.

Persistence is opt-in (production wires `floodStatePath`; tests leave it `null`). The same principle the agent core uses for tool-result spillover: "in-memory map = hot path; disk = anything you need later".

#### Pairing flow for first-time users

**The issue.** A stranger DMing the bot for the first time needs to be welcomed into the system without the bot leaking operator credentials or auto-accepting every internet rando. Hand-edited allowlists are friction.

**The resolution.** Four DM policies — `disable`, `open`, `allowlist`, `pairing` — chosen per deployment. Under `pairing`, a stranger's first message is dropped at the door and they receive an instruction:

```
Your Telegram user id: 555111222
Pairing code:
    ABCD2345
Ask the bot owner to approve with:
    nexusclaw pairing approve telegram ABCD2345
```

The operator runs that command on the host. A small persistence file (`~/.nexusclaw/pairing.json`) holds pending requests; approval writes the user into the canonical id map. A `fs.watch` watcher on the running `serve` process picks up the change in ~100ms — no restart needed. Subsequent messages from that user reach the agent.

The same rate-limit policy applies to the pairing prompts themselves so a stranger spamming "hi" 200 times doesn't burn the bot's API quota with 200 pairing replies.

#### Settings + state on disk, in user-editable JSON

**The issue.** Cross-process changes (host CLI writes; running `serve` reads) need a sync mechanism. Database is overkill; an IPC channel is fragile.

**The resolution.** Plain JSON files watched by `fs.watch`. `~/.nexusclaw/nexusclaw.json` holds operator-edited configuration (tokens, policies, allowlists). `~/.nexusclaw/pairing.json` holds bot-managed pending requests. `~/.nexusclaw/flood-state.json` holds abuse counters. The host pairing CLI and the running serve process share the same files; debounced fs watchers re-hydrate the in-memory state on every change. Atomic temp-file + rename writes mean readers never see torn writes.

#### CLI rename without breaking imports

Worth a brief mention: the binary was renamed from `nexuscode` to `nexusclaw` halfway through development. The migration was a one-line change in `package.json`'s `bin` field plus a few prompt strings — no module path renames, no import surgery — because the runtime entry point and the package name were always distinct concerns.

---

### Summary: what makes this layer different

The defining principle is **strict normalization at the seam, with a per-channel escape hatch for the parts that can't reasonably be cross-platform**. Everything else follows:

- The agent never imports anything platform-specific.
- The adapter is the only place a platform's quirks live.
- Each piece of cross-cutting state (messageId, threadId, replyToId) flows through one canonical carrier.
- Each known failure has a specific paired-data fallback (HTML + plainText, thread + no-thread, fast + with-backoff).
- Live preview (streaming) and durable delivery (final messages) are explicit pipelines instead of one mode with implicit timing.
- In-memory state has a bounded lifetime; persistent state has an opt-in disk file.

Adding a second platform — Slack, Discord, web — is a single new file under `src/remote/adapters/` implementing the `PlatformAdapter` interface. Gateway, agent, MCP, sessions, permissions, the entire core: all of it reused unchanged. That is the test of whether the architecture is genuinely generic.

---

## How the Stream Is Truly Generic: Switchable Policies and Cross-Platform Helpers

The previous section explained how Telegram is normalized into the cross-platform layer. This section is about the inverse question: what sits in the codebase that **Telegram doesn't fully exercise**, deliberately designed so the next adapter (Slack, Discord, web) can slot in without inventing new abstractions?

The honest answer is: a lot. Several decisions were made because *Telegram's* simplest implementation happened to also be the right shape for platforms that work very differently. Each one is a hint, a flag, or a verb that the Telegram adapter treats as a no-op or a default — but that becomes meaningful the moment a second adapter ships.

### Partial vs delivery: streaming policy is a constructor argument

**The issue.** Telegram supports edit-in-place: you send a bubble, then mutate its text. The user sees live thinking — characters appearing as the agent streams. Email doesn't work that way. Slack threads sort of do, but with very different rate-limit math. Discord can edit, but only within a 5-minute window. SMS can't edit at all. The platform's actual delivery semantics dictate the right UX, not the agent.

**The resolution.** The `Coordinator` takes a `partial: boolean` constructor option. It has two completely different code paths depending on the value:

```
Coordinator({ partial: true })       Coordinator({ partial: false })
─────────────────────────────         ─────────────────────────────
onText("Done")  → draft.update         onText("Done")  → buffer += "Done"
onText("!")     → draft.update         onText("!")     → buffer += "!"
turnDone()      → draft.materialize    turnDone()      → sendPayload(buffer)
                                                         buffer = ""
   user sees live growth                  user sees one finished message
```

Telegram defaults to `partial: true` because edit-in-place is cheap and the live-thinking UX is what Telegram users expect. For an SMS / email adapter, the right default would be `partial: false` — buffer the entire turn, then emit one delivery payload. **The flip is one boolean.** No code reorganization, no adapter changes, no agent-side awareness.

Why this matters past the "Telegram works" milestone: every chat platform settles on its own answer to "how live should this feel?" by setting one default. The agent stays oblivious.

### Block types: `select` is waiting for a richer platform

**The issue.** Telegram inline keyboards are buttons. That's the whole UI vocabulary — no dropdowns, no text inputs, no multi-select. Slack Block Kit, in contrast, has native `static_select`, `multi_static_select`, `datepicker`, `users_select`. Discord components include `StringSelectMenu`. A web UI has the whole HTML form vocabulary.

**The resolution.** The cross-platform `OutboundInteractive` already supports three block types:

```
type InteractiveBlock =
  | { type: "text";    text: string }
  | { type: "buttons"; buttons: InteractiveButton[] }
  | { type: "select";  placeholder?: string; options: InteractiveButton[] }
```

On Telegram, a `select` block is **rendered as buttons** by the adapter — it flattens the options into a button grid because Telegram has nothing better. On Slack, the same `select` block would render as a real `static_select` element. Same agent emission; different platform-native rendering; same callback round-trip.

So when the agent says *"give the user a dropdown to pick a branch"*, the Telegram user gets a grid of buttons and the Slack user gets a dropdown. Both work; the agent doesn't need to know which it is.

### Button styles: a hint Telegram drops, others would color

**The issue.** A "Delete" button should look dangerous. An "Approve" button should look affirmative. Telegram inline keyboards are monochrome — every button is the same neutral gray. Slack Block Kit, Discord buttons, and a web UI all have visual styles.

**The resolution.** `InteractiveButton.style?: "primary" | "secondary" | "success" | "danger"` is on the cross-platform shape. The Telegram adapter silently ignores it. Adding a Slack adapter that respects it is a one-line lookup at render time. The agent's emission doesn't change.

This is the philosophy: **expose the hint always; honor it where you can.** Cheaper than carrying conditional logic that asks "is this Telegram? then skip the style".

### The escape hatch: where platform-specific richness lives

**The issue.** Some features genuinely don't generalize. Telegram's `quoteText` has no Slack analog. Slack's `unfurl_links: false` has no Telegram analog. Discord's voice-channel `components` are uniquely Discord. Trying to express every platform's full feature set in one cross-platform type would collapse the abstraction.

**The resolution.** Every payload accepts a `channelData?: { telegram?: …, slack?: …, discord?: … }` block. Each adapter reads only its own slot. Nothing else looks at it.

```
payload.channelData = {
  telegram: { quoteText: "your line", inlineKeyboard: [[...]] },
  slack:    { blocks: [...], thread_broadcast: true },
  discord:  { components: [...], allowed_mentions: { parse: [] } },
}
```

The agent picks which platform it's targeting via `target.channel`; only that slot is read. **No adapter ever sees another adapter's escape hatch.** The Telegram inline-keyboard override demonstrates the pattern: when a caller really needs Telegram's full 2-D button layout with arbitrary callback data, they put it under `channelData.telegram.inlineKeyboard` and the adapter takes that as authoritative — wins over any generic `interactive.blocks`.

Every new platform gets its own slot the first time someone needs to express something only that platform supports. Existing slots and existing platforms are untouched.

### DraftStream verbs: each verb means something different per platform

The DraftStream interface has six verbs. Telegram uses three of them today. The others are there because they describe operations that *other* platforms have natively.

| Verb | Telegram's implementation | What it could mean elsewhere |
|---|---|---|
| `update(delta)` | Buffer + throttled `editMessageText` | Slack: edit via `chat.update`. Discord: edit within 5-min window. Web: SSE push. |
| `flush()` | Commit pending edit immediately | Slack/Discord: same. SMS: send the line now. |
| `materialize()` | No-op (the bubble is already the message) | Email: send the assembled buffer as one mail. Native draft APIs: convert draft → permanent. |
| `forceNewMessage()` | Drop in-flight tracking; next `update` opens a fresh bubble | Discord past the edit window: required (you literally can't edit anymore). |
| `clear()` | Same as `forceNewMessage` | Web UI: pop the bubble from the DOM. |
| `stop()` | Same | Native streaming protocol: send end-of-stream marker. |

The Telegram adapter treats `forceNewMessage` as a routine reset because edit-in-place is cheap. On Discord, where there's a literal time window on edits, the same verb would be **the most-used verb in the API** — the adapter would internally trigger it whenever the window expires. The agent doesn't change.

The same applies to `materialize`. Telegram doesn't need it because the live bubble *is* the permanent message. A platform with a separate draft API (some business-messaging products) would do the actual draft→post API call here. The verb exists at the interface level so the Coordinator can call it unconditionally.

### The htmlText + plainText pair is platform-neutral

The chunker doesn't return Telegram-shaped pairs — it returns a generic shape:

```
[{ htmlText: "<chunk-1 HTML>", plainText: "<chunk-1 plain>" }, …]
```

Telegram uses the HTML version for the wire and the plain version for the parse-error retry. A Slack adapter would do something similar: try the formatted version (`mrkdwn` or `blocks`) first, fall back to plain text on a parse rejection. The chunker doesn't need to know which is which — it just guarantees that for every chunk, both representations exist and are kept in sync.

The `htmlToPlainText` helper is named for what it does, not for the platform. Any adapter that uses a tag-bearing format can call it to derive the fallback. Stripping `<b>`, `<i>`, `<code>` and decoding standard entities works the same on every platform that uses an HTML subset; even platforms that use a different markup (Slack mrkdwn) can share the entity-decoding portion.

### Generic primitives ready to be reused by the next adapter

A handful of pieces in the remote layer have **no Telegram-specific logic at all**. They're sitting in the codebase because they were the right shape for what the Telegram adapter needed, and they happen to be the right shape for every other adapter too.

| Primitive | What it does | What Telegram uses it for | What another adapter would use it for |
|---|---|---|---|
| `Sequentializer` | Single-lane FIFO that serializes any async dispatch | Ordered inbound update processing | Slack: serialize bot events. Web: serialize websocket frames. |
| `IdentityQueue` | Per-key FIFO with parallel keys | Per-canonical-user message queue | Any platform with concurrent users + per-user ordering requirements. |
| `OutboundRouter` | Picks adapter by `target.channel` | Routes telegram-targeted payloads | Routes any future channel name with no router change. |
| `IdentityResolver` (function type) | Maps `RemoteIdentity → canonical user id` | Telegram userMap lookup | Slack: workspace → canonical map. OAuth: token → user. |
| `FloodGuard` (the algorithm) | Debounce + rate-limit + queue-depth cap + abuse counter | Telegram inbound throttling | Any platform with per-user rate limits to honor. |
| `truncateForLog` | Recursive structural truncation for log dumps | Truncating raw `Update` objects in verbose mode | Any platform whose update objects are too big to log verbatim. |

None of these import anything platform-specific. None of them know what a `chatId` is. They operate on opaque keys and untyped values. Each is one `import` away from being used in a Slack or Discord adapter.

### Cross-platform fields with no Telegram cost

Two small fields demonstrate the pattern further:

**`forceDocument`** — a generic *"send this uncompressed / as a file, not as preview-quality content"* hint. On Telegram, it switches `sendPhoto` to `sendDocument`. On Slack, it would set `as_user: false` or pick a file upload over an image-embed render. On Discord, it would attach as a file rather than embed as a thumbnail. The agent just says "the user wants the full-quality version" and each adapter knows what that means for its platform.

**`silent`** — a generic *"this message shouldn't trigger an attention notification"* hint. On Telegram it sets `disable_notification: true`. On Slack it would set `unfurl_links: false` and skip the @-mention notification. On Discord it would suppress the push notification. The semantic ("don't ping the user") is shared; the wire field differs per platform.

Both fields are on `OutboundPayload`. Neither requires the agent to know what platform it's writing for.

### What slotting in Slack would actually look like

Concrete walkthrough — what a `SlackAdapter` would consist of, and what it would reuse:

1. **One new file** under `src/remote/adapters/slack.ts` implementing `PlatformAdapter` (`start / stop / onEvent / send / prompt / sendPayload / draftFor`).
2. **Inbound mapping**: Slack's Events API webhook payloads → `RemoteEvent`. Reuses `IdentityQueue`, `Sequentializer`, the same `RemoteIdentity` carrier.
3. **Outbound mapping**: `OutboundPayload` → `chat.postMessage` calls. New `markdownToSlackMrkdwn` helper (analogous to `markdownToTelegramHtml`, similar shape, different output). Reuses `chunkHtmlMessage`'s pattern (or a Slack-specific variant) and the `htmlText + plainText` pair concept.
4. **Block translation**: `OutboundInteractive.blocks` → Slack Block Kit JSON. The `select` block finally renders as a real `static_select`. Button `style: "primary" | "danger"` maps to Slack's native button styles.
5. **Escape hatch**: read `channelData.slack` for native Block Kit overrides.
6. **DraftStream**: implement using Slack's `chat.update` API. `forceNewMessage` is rarely needed because Slack doesn't have a hard edit window.
7. **Coordinator**: instantiate with `partial: true` (Slack supports edits) or `partial: false` (if the operator prefers batched messages); same Coordinator class.
8. **Settings**: add `slack: { token, …, ... }` block to the existing JSON schema. Add one branch in `buildAdapters`. Add one branch in `buildIdentityResolver`.

**What is *not* changed**:

- The agent core, top to bottom.
- The gateway, top to bottom (including `IdentityQueue`, the canonical-user binding, the slash-command dispatch, the permission bridge).
- `OutboundRouter`, `RemoteEvent`, `OutboundPayload`, `OutboundTarget`, `DraftStream`, `Coordinator` — all reused as-is.
- The pairing CLI shape, the flood-guard logic, the verbose logger, the sequentializer.
- Sessions, memory, MCP, sub-agents, skills.

The cost of platform #2 is **one adapter file plus four glue branches in JSON-handling code**. Nothing else moves. That's the difference between a "Telegram bot with extension points" and a multi-platform agent that happens to ship with Telegram first.

### Summary: switchable policy is the architecture

The thread that ties all of the above together: **every cross-platform decision is expressed as a setting, a hint, or a verb — not as a hardcoded path.**

- Streaming UX is a `partial` flag on the Coordinator, not branching code.
- Button visual style is a `style` field on the button, not a per-adapter renderer.
- Native-feature access is a per-channel slot in `channelData`, not a type system extension.
- Platform-specific edit semantics are six interface verbs, not a class hierarchy.
- Send-mode (compressed vs file) is a `forceDocument` boolean, not a payload kind taxonomy.
- Notification urgency is a `silent` flag, not a platform-specific options object.

The Telegram adapter exercises a particular subset of these settings. Every untouched setting is a slot waiting for a platform whose native semantics make that switch the natural default. That's what makes the stream **truly** generic — not the agent's blindness to platforms, but the carefully shaped surface area that lets each platform express its own answer to the same questions.

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
