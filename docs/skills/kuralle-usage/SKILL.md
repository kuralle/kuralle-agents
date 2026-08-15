---
name: kuralle-usage
description: Build and debug Kuralle apps end-to-end. Use when creating conversational agents, SOP flows, routing, auto-retrieve CAG, tools, and runtime integrations.
---

# Kuralle Usage (Dev Advocate)

This skill is a map. Read only the sections you need and follow the checklists.

## Read this first

- Default to **npm install** usage. Monorepo paths are fallback only.
- Put **SOP in flows**, not prompts.
- **Pure dispatchers** (`routes` only, no answering surface) route silently; **answering agents** use host-control tools + guard so dispatch never leaks.
- Keep tools deterministic and data-only; flow control is node transitions.

## v2 mental model

| Concept | API |
|---------|-----|
| Agent | `defineAgent({ id, instructions, model, tools, globalTools, flows, routes, handoffs, agents })` |
| Flow | `defineFlow({ name, description, start, nodes, gates? })` — validates the graph, **throws** on structural issues |
| Nodes | `reply` (optional `toolScope`: `'open'` \| `'base'` \| `'closed'`, default `'open'`), `collect`, `action`, `decide` |
| Flow JSON dialect | `FlowDefinition` (data, not code) + `validateFlowDefinition`; register live via `runtime.addDynamicFlows(defs, { agentId })` |
| Durable flow run | `runtime.run({ sessionId, kind: 'flow', flowName })` mints a run; resume via `runtime.run({ sessionId, runId })`; `await handle.runId` |
| Tools | `defineTool` + `buildToolSet` for model; `tools` for durable `ctx.tool` |
| Visibility vs auth | `toolScope` = what the model **sees**; `Policy` / `needsApproval` = whether a call may **run** |
| Runtime | `createRuntime({ agents, defaultAgentId })` |
| Turn | `runtime.run({ sessionId, input, driver? })` → `TurnHandle` |
| Text channel | default `TextDriver` |

Behavior is **derived from field presence** — no agent type tag, no `routing.mode`. A routes/agents-only agent (no answering surface) is a silent pure dispatcher; an answering agent folds host-control tools (`enter_flow`/`transfer_to_agent`) + a guard into its turn.

## Build path

Define agents with `defineAgent` in TypeScript — full type inference, custom node handlers, dynamic behavior. See `references/runtime.md` and `references/code-examples.md`.

## Find local docs (npm)

Use **local, version-matched docs** first:

- Tools guides: `rg -n "<topic>" node_modules/@kuralle-agents/tools/guides/`

Fallback (monorepo only):

- Examples: `packages/core/examples/`
- Guides: `packages/tools/guides/`

## Navigation

Read only what you need:

**Getting started:**
- `references/runtime.md` - `createRuntime`, `TurnHandle`, drivers, durable resume
- `references/agents.md` - `defineAgent`, derived behavior, handoffs
- `references/code-examples.md` - code-first examples in core

**Flows and tools:**
- `references/flows.md` - `defineFlow`, node kinds, returned transitions, definition-time validation, gates
- `references/flow-definitions.md` - `FlowDefinition` JSON dialect, predicate DSL, `addDynamicFlows`, stored-flows HTTP surface, flow-builder agent, `FlowDriftError`
- `references/extraction-nodes.md` - `collect` nodes, Standard Schema, multi-turn gather, tier-0 resolvers
- `references/triage.md` - `routes` + model-reasoned routing without leaks
- `references/tools.md` - `defineTool`, `tools`, approval pauses
- `references/llm-solidness-playbook.md` - production hardening checklist

**Capabilities:**
- `references/agent-prompt.md` - structured prompts, voice rules, token budgeting
- `references/guardrails.md` - input/output processors, safety-blocked events
- `references/memory.md` - cross-session memory, `userId` requirement

**Retrieval:**
- `references/cag.md` - CAG and auto-retrieve
- `references/rag.md` - rag package 80/20

**Observability:**
- `references/analytics.md` - `@kuralle-agents/analytics-sdk`
- `references/debugging.md` - common failures + fixes

**Deployment:**
- `references/deployment.md` - hono + cloudflare adapters
- `references/adapters.md` - hono + cloudflare 80/20
- `references/stores.md` - redis/postgres 80/20

**Reference:**
- `references/core.md` - core package 80/20
- `references/tools-guide.md` - tools package 80/20
- `references/skills.md` - Skills (knowledge base for agents)
- `references/examples.md` - examples index and commands

Rules:

- `rules/sop-in-flow.md`
- `rules/triage-no-leaks.md`
- `rules/tool-output-contract.md`
- `rules/grounding.md`
- `rules/session-state.md`
- `rules/llm-agent-solidness.md`

## Primary workflow (checklist)

1) **Read relevant docs**
   - `references/runtime.md` + `references/code-examples.md`

2) **Define one agent**
   - `instructions` for persona + global rules
   - `flows` for SOP (node kinds, not prompt walls)
   - `routes` for dispatch (structured mode)
   - `handoffs` / `agents` for escalation

3) **Define tools**
   - `defineTool` with Standard Schema input
   - Register in `tools` for durable execution
   - `buildToolSet` for model-facing `tools`
   - Tools return data only

4) **Wire runtime**
   ```ts
   const runtime = createRuntime({ agents: [agent], defaultAgentId: agent.id });
   const handle = runtime.run({ input, sessionId });
   for await (const part of handle.events) { … }
   ```

5) **Enable grounding**
   - CAG tools + `autoRetrieve` if always grounded

6) **Harden**
   - Apply `references/llm-solidness-playbook.md`
   - Idempotent side effects via effect log
   - Transcript + event visibility for replay

7) **Run + debug**
   - Verify streaming (`text-delta` … `done`)
   - Confirm `sessionId` persists across turns

## Code-first minimal example

```ts
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import {
  createRuntime, defineAgent, defineFlow, defineTool,
  collect, reply, buildToolSet,
} from '@kuralle-agents/core';

const echo = defineTool({
  name: 'echo',
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

const done = reply({
  id: 'done',
  instructions: 'Confirm and say goodbye.',
  next: () => ({ end: 'complete' }),
});

const gather = collect({
  id: 'gather',
  schema: z.object({ name: z.string() }),
  required: ['name'],
  instructions: (m) => `Ask for: ${m.join(', ')}`,
  onComplete: () => done,
});

const agent = defineAgent({
  id: 'demo',
  model: openai('gpt-4o-mini'),
  tools: { echo },
  flows: [defineFlow({
    name: 'intake',
    description: 'Collect a name',
    start: gather,
    nodes: [gather, done],
  })],
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'demo' });
```

## Non-negotiables

- SOP lives in flows (`reply`/`collect`/`action`/`decide`), not system prompts.
- Transition targets are registered nodes referenced by object or `{ goto: '<id>' }` — `defineFlow` throws on inline node objects and transition thunks.
- Model-reasoned routing when `routes` dispatch.
- Tools must not speak to users.
- Flow control via node `next` / returned transitions — not tool prose.
- Grounding must be explicit if you promise it.
- Side-effecting tools go through `tools` / `ctx.tool` for exactly-once-modulo-idempotency (finished steps replay without re-executing; a crash mid-effect re-runs it, deduped by the idempotency key).
- `userId` required for user-scoped memory, and it must match `^[A-Za-z0-9._@+:~|-]+$` — a session without one, or with one outside that set, runs with no user memory rather than a shared fallback.

## When to stop

If you need to paste more than ~20 lines of SOP into a prompt, stop and move it to a `defineFlow` with node kinds.
