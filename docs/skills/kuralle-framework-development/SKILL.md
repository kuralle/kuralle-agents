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
  hostLoop    route → runFlow → free converse → handoff loop
  closeRun    persist, memory ingest, outcome

runFlow       imperative loop over FlowNode handlers
  reply/collect → ChannelDriver.runAgentTurn
  action        → node.run(state, ctx) — no LLM
  decide        → driver.runStructured

ctx.tool / ctx.approve / ctx.signal → effect log (exactly-once)
```

## Find local docs (npm)

```bash
rg -n "<topic>" node_modules/@kuralle-agents/core/src/
rg -n "<topic>" node_modules/@kuralle-agents/tools/guides/
```

Fallback (monorepo):

- Examples: `packages/kuralle-core/examples/`
- Tests: `packages/kuralle-core/test/`

## Package structure (where to edit)

### Core Framework

| Package | Path | What it contains |
|---------|------|------------------|
| `@kuralle-agents/core` | `packages/kuralle-core/` | Types, `Runtime`, `hostLoop`, `runFlow`, drivers, effect tools |
| `@kuralle-agents/tools` | `packages/kuralle-tools/` | CAG tools |
| `@kuralle-agents/rag` | `packages/kuralle-rag/` | RAG primitives |

### Adapters & Stores

| Package | Path |
|---------|------|
| `@kuralle-agents/hono-server` | `packages/kuralle-hono-server/` |
| `@kuralle-agents/cf-agent` | `packages/kuralle-cf-agent/` |
| `@kuralle-agents/redis-store` | `packages/kuralle-redis-store/` |
| `@kuralle-agents/postgres-store` | `packages/kuralle-postgres-store/` |
| `@kuralle-agents/livekit-plugin` | `packages/kuralle-livekit-plugin/` |

## Key directories by concern

### Agent authoring surface

```
packages/kuralle-core/src/
├── types/agentConfig.ts      # AgentConfig, defineAgent
├── types/flow.ts             # Flow, FlowNode, Transition, node helpers
├── types/route.ts            # Route, RoutingPolicy
├── types/effectTool.ts       # defineTool, Tool
├── authoring/                # Re-exports of defineAgent, nodes
└── runtime/deriveAgent.ts    # Capability derivation from field presence
```

### Flow execution

```
packages/kuralle-core/src/
├── flow/runFlow.ts           # Imperative flow loop
├── flow/reduceTransition.ts  # Transition → events + state update
├── flow/nodeBuilders.ts      # Node prompt/tool assembly
└── runtime/hostLoop.ts       # Composition: route, flow, converse, handoff
```

### Runtime & durability

```
packages/kuralle-core/src/
├── runtime/Runtime.ts        # createRuntime, HarnessConfig, RunOptions
├── runtime/openRun.ts        # Session + RunState load, replay entry
├── runtime/closeRun.ts       # Persist, memory, outcome
├── runtime/durable/          # Effect log, RunStore, replay
├── runtime/channels/         # TextDriver, VoiceDriver
└── events/TurnHandle.ts      # Event bus, TurnHandle
```

### Tools (effect path)

```
packages/kuralle-core/src/
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
packages/kuralle-core/src/types/
```

- [ ] Extend `AgentConfig`, `FlowNode`, `HarnessConfig`, etc.
- [ ] Export from `types/index.ts`
- [ ] Update `deriveAgent.ts` if behavior derivation changes

### 3. Implement

- [ ] Core: `hostLoop`, `runFlow`, drivers, effect log as needed
- [ ] Adapters if wire format changes

### 4. Add or update examples

```
packages/kuralle-core/examples/agents/
packages/kuralle-core/examples/flows/
```

- [ ] Minimal working example
- [ ] Run with `npx tsx examples/...`

### 5. Test

```bash
cd packages/kuralle-core
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

1. Update node types in `types/flow.ts`
2. Update `runFlow.ts` dispatch for new node kind
3. Update `reduceTransition.ts` if transition shapes change
4. Run all flow examples

### Tool / effect log changes

1. Update `types/effectTool.ts` and `ToolExecutor.ts`
2. Ensure replay short-circuits in `runtime/durable/replay.ts`
3. Verify text and voice paths (`TextDriver`, `VoiceDriver`)

## Guardrails (non-negotiable)

### Streaming stability

Never change event structure without a major version:

- `text-start`, `text-delta{id,delta}`, `text-end`, `text-cancel`, `tool-call`, `tool-result`, `tool-error`
- `node-enter`, `node-exit`, `flow-transition`, `flow-end`
- `handoff`, `paused`, `done`, `error`, `interrupted`

### No new agent types

Extend `AgentConfig` fields and `deriveAgentCapabilities`. Do not add `type` discriminators or parallel agent classes.

### Routing safety

Structured routing must not emit user-visible dispatch text.

### Durability

Side effects go through `ctx.*` and the effect log. Do not add ad-hoc session mutation that bypasses replay.

### Performance

- No O(n²) on hot paths
- Voice: effect log appends async at turn boundaries — never on audio path
- Streaming must stay low-latency

### Testing

- Every feature needs an example that runs
- Do not break existing examples in `packages/kuralle-core/examples/`

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
2. New package `packages/kuralle-<store>-store/`
3. Example + README

### Add an HTTP adapter

1. Mirror `packages/kuralle-hono-server` routes
2. Wire `runtime.run()` → `TurnHandle.toResponseStream()`
3. Example server

## Debugging

```bash
# Types
cd packages/kuralle-core && npx tsc --noEmit

# Minimal example
cd packages/kuralle-core/examples/agents
npx tsx form-filler.ts

# Unit tests
bun test packages/kuralle-core/test/core-flow/
bun test packages/kuralle-core/test/core-agent/
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
