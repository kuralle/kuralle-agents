---
name: kuralle-framework-development
description: Extend and modify Kuralle core/framework packages. Use when changing runtime behavior, agent primitives, flow engine, config loader, tools interfaces, session stores, adapters, or adding new framework features.
---

# Kuralle Framework Development

This skill is for internal developers extending the Kuralle framework. Keep changes minimal, consistent, and well-tested.

## Read this first

- **Stability first**: Breaking changes require version bumps across all packages
- **Types lead**: Update types before implementation
- **Examples prove behavior**: Every feature needs a working example
- **Streaming semantics are sacred**: Never change the assistant-text lifecycle (`text-start` / `text-delta{id,delta}` / `text-end` / `text-cancel`), `tool-call`, `done` events without a major version
- **One agent model**: No new agent type discriminators — extend `AgentConfig` fields and derivation in `deriveAgent.ts`
- **Test before committing**: Run existing examples to verify nothing breaks

## v2 architecture map

```
Runtime.run(opts) → TurnHandle
  openRun     load Session + RunState + effect log, replay
              runId addressing: opts.runId resumes (fail-closed);
              opts.kind:'flow' mints a headless flow run (+ flowName)
  hostLoop    route → runFlow → free converse → handoff loop
  closeRun    persist, run extractors if the trigger fires, outcome

runFlow       imperative loop over FlowNode handlers
  reply/collect → ChannelDriver.runAgentTurn
  action        → node.run(state, ctx) — no LLM
  decide        → driver.runStructured
  terminal transition → evaluateFlowGates → verification record

ctx.tool / ctx.approve / ctx.signal → effect log (exactly-once-modulo-idempotency)

Flow registry: Runtime keeps one LiveFlowCatalog per agent (code flows +
dynamic FlowDefinitions), mutated only under flowCatalogMutex by
addDynamicFlows / removeDynamicFlow / loadDynamicFlows; liveAgent() overlays
the catalog onto AgentConfig per turn. A parked run pins the flow digest;
resume against a changed definition throws FlowDriftError.
```

## Find local docs (npm)

```bash
rg -n "<topic>" node_modules/@kuralle-agents/core/src/
rg -n "<topic>" node_modules/@kuralle-agents/tools/guides/
```

Fallback (monorepo):

- Examples: `packages/core/examples/`
- Tests: `packages/core/test/`

## Package structure (where to edit)

### Core Framework

| Package | Path | What it contains |
|---------|------|------------------|
| `@kuralle-agents/core` | `packages/core/` | Types, `Runtime`, `hostLoop`, `runFlow`, drivers, effect tools |
| `@kuralle-agents/tools` | `packages/tools/` | CAG tools |
| `@kuralle-agents/rag` | `packages/rag/` | RAG primitives |

### Adapters & Stores

| Package | Path |
|---------|------|
| `@kuralle-agents/hono-server` | `packages/hono-server/` |
| `@kuralle-agents/cf-agent` | `packages/cf-agent/` |
| `@kuralle-agents/redis-store` | `packages/redis-store/` |
| `@kuralle-agents/postgres-store` | `packages/postgres-store/` |

## Key directories by concern

### Agent authoring surface

```
packages/core/src/
├── types/agentConfig.ts      # AgentConfig, defineAgent
├── types/flow.ts             # Flow, FlowNode, Transition, node helpers
├── types/route.ts            # Route, RoutingPolicy
├── types/effectTool.ts       # defineTool, Tool
├── authoring/                # Re-exports of defineAgent, nodes
└── runtime/deriveAgent.ts    # Capability derivation from field presence
```

### Flow execution

```
packages/core/src/
├── flow/runFlow.ts           # Imperative flow loop
├── flow/reduceTransition.ts  # Transition → events + state update
├── flow/nodeBuilders.ts      # Node prompt/tool assembly
├── flow/slotResolution.ts    # Tier-0 collect resolvers + extraction provenance guard
├── flow/evaluateGates.ts     # Flow gates (predicate/judge) at terminal transitions
└── runtime/hostLoop.ts       # Composition: route, flow, converse, handoff
```

### Flow definitions (JSON dialect + dynamic registration)

```
packages/core/src/flows/
├── definition/types.ts       # FlowDefinition, node defs, TransitionRef, FlowGateSpec
├── definition/schema.ts      # zod schemas (flowDefinitionSchema, flowGateSpecSchema)
├── definition/predicate.ts   # Predicate DSL + evaluatePredicate
├── definition/mapping.ts     # MappingConfig + ${...} template validation
├── definition/rehydrate.ts   # FlowDefinition → live Flow (strict/lenient)
├── definition/digest.ts      # canonical digest (flowDigest, digestForLiveFlow)
├── definition/validate/      # validateFlowDefinition, issue codes, repair actions
│                             #   code-flow.ts backs defineFlow's throw path
├── definition/store.ts       # FlowDefinitionsStore contract (versioned, one active/name)
├── definition/authoring.ts   # AuthoringFlowDefinition, NL predicates ({ nl })
├── authoring/                # createFlowBuilderAgent, playbook, NL predicate compiler
├── addDynamicFlows.ts        # registerDynamicFlowBundle, loadDynamicFlowsIntoCatalog
└── liveFlowCatalog.ts        # LiveFlowCatalog (code + dynamic overlay per agent)
```

Both dialects share one validator core: `defineFlow` projects the code graph through
`validate/code-flow.ts` into the same structure checks `validateFlowDefinition` runs.
A transition-shape change must update `types/flow.ts`, `definition/types.ts`, and
`validate/` together.

### Runtime & durability

```
packages/core/src/
├── runtime/Runtime.ts        # createRuntime, HarnessConfig, RunOptions,
│                             #   addDynamicFlows / removeDynamicFlow / loadDynamicFlows
├── runtime/openRun.ts        # Session + RunState load, replay entry, runId addressing
├── runtime/closeRun.ts       # Persist, memory, outcome
├── runtime/durable/RunStore.ts        # RunStore contract + typed errors
├── runtime/durable/SessionRunStore.ts # Default journal over sessionStore
├── runtime/durable/replay.ts          # Effect log replay
├── runtime/durable/flowPin.ts         # Digest pinning, FlowDriftError
├── runtime/durable/runLease.ts        # Execution leases (stale = orphaned)
├── runtime/durable/sweep.ts           # recoverOrphanedRuns, sweepDeadlines
├── runtime/durable/findUnresumableRuns.ts
├── runtime/channels/         # TextDriver
└── events/TurnHandle.ts      # Event bus, TurnHandle (events, runId promise)
```

Shared `RunStore` backends live outside core: `PostgresRunStore`
(`packages/postgres-store/`), `SqlRunStore` (`packages/cf-agent/`, DO SQLite).
The stored-flows HTTP surface (`/api/stored/flows`, Policy-gated as
`stored-flows:read`/`write`) is `packages/hono-server/src/storedFlowsRouter.ts`
and `packages/cf-agent/src/storedFlowsHttp.ts` — keep the two in lockstep.

### Tools (effect path)

```
packages/core/src/
├── tools/effect/defineTool.ts
├── tools/effect/ToolExecutor.ts
└── tools/effect/schema.ts
```

## Change checklist

### 1. Plan the change
- [ ] Identify affected packages
- [ ] Check if breaking — plan version bump
- [ ] Identify examples to add/update

### 2. Update types first

```
packages/core/src/types/
```

- [ ] Extend `AgentConfig`, `FlowNode`, `HarnessConfig`, etc.
- [ ] Export from `types/index.ts`
- [ ] Update `deriveAgent.ts` if behavior derivation changes

### 3. Implement

- [ ] Core: `hostLoop`, `runFlow`, drivers, effect log as needed
- [ ] Adapters if wire format changes

### 4. Add or update examples

```
packages/core/examples/agents/
packages/core/examples/flows/
```

- [ ] Minimal working example
- [ ] Run with `npx tsx examples/...`

### 5. Test

```bash
cd packages/core
bun test test/core-agent/
bun test test/core-flow/
npx tsx examples/agents/form-filler.ts
```

### 6. Update docs

- [ ] Relevant guide or skill if public surface changed
- [ ] CHANGELOG via changeset

## Patterns to follow

### Runtime flags

1. Add to `HarnessConfig` in `runtime/Runtime.ts`
2. Thread through `openRun` / `hostLoop` / `closeRun` as needed
3. Example proving behavior

### Flow changes

1. Update node types in `types/flow.ts` **and** the JSON dialect in `flows/definition/types.ts` + `schema.ts`
2. Update `runFlow.ts` dispatch for new node kind, and `definition/rehydrate.ts` for the dialect
3. Update `reduceTransition.ts` and `flows/definition/validate/` if transition shapes change
4. Node/transition semantics feed the digest — check `definition/digest.ts` so parked runs do not spuriously hit `FlowDriftError` (or silently miss real drift)
5. Run all flow examples

### Tool / effect log changes

1. Update `types/effectTool.ts` and `ToolExecutor.ts`
2. Ensure replay short-circuits in `runtime/durable/replay.ts`
3. Verify the text path (`TextDriver`)

## Guardrails (non-negotiable)

### Streaming stability

Never change event structure without a major version:

- Every event is `{ channel, type, payload }`; variant fields belong in the named payload
- `text-start`, `text-delta`, `text-end`, `text-cancel`, `tool-call`, `tool-result`
- `node-enter`, `node-exit`, `flow-transition`, `flow-end`
- `handoff`, `paused`, `done`, `error`, `interrupted`

### No new agent types

Extend `AgentConfig` fields and `deriveAgentCapabilities`. Do not add `type` discriminators or parallel agent classes.

### Routing safety

Routing/dispatch must not emit user-visible dispatch text.

### Durability

Side effects go through `ctx.*` and the effect log. Do not add ad-hoc session mutation that bypasses replay.

### Performance

- No O(n²) on hot paths
- Streaming must stay low-latency

### Testing

- Every feature needs an example that runs
- Do not break existing examples in `packages/core/examples/`

## Version bumping

All packages version together via changesets (`pnpm changeset` → `pnpm release`).

- **Major**: breaking `AgentConfig`, transition shapes, event types, `HarnessConfig`
- **Minor**: new optional fields, new node kind, new hooks
- **Patch**: bug fixes only

## Common tasks

### Add a derived behavior flag on AgentConfig

1. Add optional field to `AgentConfig`
2. Update `deriveAgentCapabilities` in `runtime/deriveAgent.ts`
3. Branch in `hostLoop.ts` or `select.ts`
4. Example + test

### Add a hook

1. Add to `types/hooks.ts`
2. Call from `Runtime.ts`, `hostLoop.ts`, or `runFlow.ts` with `RunContext`
3. Example using the hook

### Add a session store backend

1. Implement `SessionStore` from core
2. New package `packages/<store>-store/`
3. Example + README

### Add an HTTP adapter

1. Mirror `packages/hono-server` routes
2. Wire `runtime.run()` → `TurnHandle.toUIMessageStreamResponse()` (web default) or `toResponseStream('sse')` for raw JSON-SSE
3. Example server

## Debugging

```bash
# Types
cd packages/core && npx tsc --noEmit

# Minimal example
cd packages/core/examples/agents
npx tsx form-filler.ts

# Unit tests
bun test packages/core/test/core-flow/
bun test packages/core/test/core-agent/
```

## When to ask for review

- Breaking changes to `AgentConfig`, transitions, or stream events
- New core abstractions
- Effect log / replay semantics changes
- Cross-package coordination
- Version bump decisions

## References

- `../kuralle-usage/SKILL.md` — user-facing development
- `../../../README.md` — onboarding
- `../../../CLAUDE.md` — project guidance
- `apps/docs/` — the documentation site
