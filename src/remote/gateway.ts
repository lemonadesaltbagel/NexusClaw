// ---------------------------------------------------------------------------
// Gateway — transport-agnostic core of remote control.
//
// Plugs adapters into the Agent's existing callback surface:
//   adapter ──RemoteEvent──▶ Gateway ──agent.chat──▶ Agent
//                                        ▲                │
//                                        │       callbacks│
//                                  per-turn sink ◀────────┘
//
// One Agent is created per canonical user (the identity-resolver maps a
// platform-native id to a canonical id). The Agent's callbacks are bound
// once at construction time to a *mutable sink* held by the Gateway; before
// each turn the sink is swapped so the output is routed back through the
// adapter the message came in on.
// ---------------------------------------------------------------------------

import type { Agent, PlanApprovalResult } from "@/core/agent";
import { getSkillByName, resolveSkillPrompt } from "@/core/skills";
import { IdentityQueue } from "@/remote/queue";
import {
  identityKey,
  type PlatformAdapter,
  type RemoteEvent,
  type RemoteIdentity,
  type RemoteOutput,
  type RemotePromptReply,
} from "@/remote/types";

// ---------------------------------------------------------------------------
// AgentCallbacks — the subset of AgentOptions the Gateway controls.
// The serve command builds the rest (provider, MCP, system prompt, tools).
// ---------------------------------------------------------------------------

export interface AgentCallbacks {
  onText: (delta: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string) => void;
  confirmDangerous: (message: string) => Promise<boolean>;
  planApprovalFn: (planContent: string) => Promise<PlanApprovalResult>;
}

/** Builds an Agent for a canonical user, given the gateway's callbacks. */
export type AgentFactory = (
  canonicalUserId: string,
  callbacks: AgentCallbacks,
) => Promise<Agent>;

/** Maps a remote identity to a canonical user id, or null to deny. */
export type IdentityResolver = (id: RemoteIdentity) => string | null;

// ---------------------------------------------------------------------------
// Per-turn routing sink — captured by Agent callbacks at construction and
// rewritten by the Gateway before each turn so output flows back to the
// originating adapter.
// ---------------------------------------------------------------------------

interface Sink {
  adapter: PlatformAdapter;
  identity: RemoteIdentity;
}

interface UserBinding {
  agent: Agent;
  sink: { current: Sink | null };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export interface GatewayOptions {
  resolveIdentity: IdentityResolver;
  agentFactory: AgentFactory;
}

export class Gateway {
  private adapters: PlatformAdapter[] = [];
  private bindings = new Map<string, UserBinding>(); // canonicalUserId → binding
  private queue = new IdentityQueue();

  constructor(private opts: GatewayOptions) {}

  registerAdapter(a: PlatformAdapter): void {
    a.onEvent((e) => this.handleEvent(a, e));
    this.adapters.push(a);
  }

  async start(): Promise<void> {
    for (const a of this.adapters) await a.start();
  }

  async stop(): Promise<void> {
    for (const a of this.adapters) {
      try { await a.stop(); } catch { /* best effort */ }
    }
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private handleEvent(adapter: PlatformAdapter, e: RemoteEvent): void {
    const canonicalId = this.opts.resolveIdentity(e.from);
    if (!canonicalId) {
      void adapter.send(e.from, {
        kind: "system",
        level: "error",
        text: "Unauthorized.",
      });
      return;
    }

    // Interrupts bypass the queue so they actually interrupt.
    if (e.kind === "interrupt") {
      const b = this.bindings.get(canonicalId);
      if (b?.agent.isProcessing) b.agent.abort();
      return;
    }

    void this.queue.submit(identityKey(e.from), async () => {
      const binding = await this.getOrCreateBinding(canonicalId);
      binding.sink.current = { adapter, identity: e.from };
      try {
        await this.dispatch(binding, e);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await adapter.send(e.from, { kind: "system", level: "error", text: msg });
      } finally {
        await adapter.send(e.from, { kind: "turn_done" });
        binding.sink.current = null;
      }
    });
  }

  private async dispatch(binding: UserBinding, e: RemoteEvent): Promise<void> {
    if (e.kind === "message") {
      await binding.agent.chat(e.text);
      return;
    }
    if (e.kind === "command") {
      await this.handleCommand(binding, e.name, e.args);
      return;
    }
    // "callback" events are consumed by adapter.prompt() resolvers — they
    // do not arrive here in stage 1. Reserved for future use.
  }

  private async handleCommand(
    binding: UserBinding,
    name: string,
    args: string,
  ): Promise<void> {
    const { agent, sink } = binding;
    const reply = (text: string): void => {
      void sink.current?.adapter.send(sink.current.identity, {
        kind: "system",
        level: "info",
        text,
      });
    };

    switch (name) {
      case "clear":
        agent.clearHistory();
        reply("History cleared.");
        return;
      case "plan": {
        const mode = agent.togglePlanMode();
        reply(`Permission mode: ${mode}`);
        return;
      }
      case "compact":
        await agent.compact();
        reply("Conversation compacted.");
        return;
      case "cost":
        // showCost writes to stdout; rendering for remote is stage-2 polish.
        agent.showCost();
        reply("Cost printed to server log.");
        return;
      default: {
        const skill = getSkillByName(name);
        if (skill && skill.userInvocable) {
          await agent.chat(resolveSkillPrompt(skill, args));
          return;
        }
        reply(`Unknown command: /${name}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-user Agent lifecycle
  // -------------------------------------------------------------------------

  private async getOrCreateBinding(canonicalUserId: string): Promise<UserBinding> {
    const existing = this.bindings.get(canonicalUserId);
    if (existing) return existing;

    const sink: { current: Sink | null } = { current: null };

    const send = (out: RemoteOutput): void => {
      const s = sink.current;
      if (s) void s.adapter.send(s.identity, out);
    };

    const callbacks: AgentCallbacks = {
      onText:       (delta) => send({ kind: "text", delta }),
      onToolCall:   (n, i)  => send({ kind: "tool_call", name: n, input: i }),
      onToolResult: (n, r)  => send({ kind: "tool_result", name: n, result: r, ok: true }),
      confirmDangerous: async (message) => {
        const s = sink.current;
        if (!s) return false;
        const r = await s.adapter.prompt({ kind: "confirm", to: s.identity, message });
        return r.kind === "confirm" && r.allowed;
      },
      planApprovalFn: async (planContent) => promptForPlan(sink, planContent),
    };

    const agent = await this.opts.agentFactory(canonicalUserId, callbacks);
    const binding: UserBinding = { agent, sink };
    this.bindings.set(canonicalUserId, binding);
    return binding;
  }
}

// ---------------------------------------------------------------------------
// Plan-approval helper — translates between PlanApprovalResult and the
// platform-agnostic prompt vocabulary.
// ---------------------------------------------------------------------------

const PLAN_CHOICES: ReadonlyArray<{ id: PlanApprovalResult["choice"]; label: string }> = [
  { id: "clear-and-execute", label: "Clear & Execute" },
  { id: "execute",           label: "Execute" },
  { id: "manual-execute",    label: "Manual" },
  { id: "keep-planning",     label: "Keep planning" },
];

async function promptForPlan(
  sink: { current: Sink | null },
  planContent: string,
): Promise<PlanApprovalResult> {
  const s = sink.current;
  if (!s) return { choice: "keep-planning" };
  const reply: RemotePromptReply = await s.adapter.prompt({
    kind: "plan_approval",
    to: s.identity,
    planContent,
    choices: PLAN_CHOICES,
  });
  if (reply.kind !== "plan_approval") return { choice: "keep-planning" };
  const valid = PLAN_CHOICES.find((c) => c.id === reply.choiceId);
  return valid
    ? { choice: valid.id, feedback: reply.feedback }
    : { choice: "keep-planning" };
}
