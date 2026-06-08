# Runtime Internals: `openRun` → `hostLoop` → `closeRun`

These are the internals shared by both `TextDriver` and `VoiceDriver`. You rarely call them directly — `createRuntime` wires them — but understanding them is essential for voice agents, custom hooks, and advanced observability.

## Turn lifecycle

Every `runtime.run()` follows one path:

```
openRun  → load session, RunState, effect log; replay recorded effects
hostLoop → route → runFlow → free converse → handoff loop
closeRun → persist RunState, memory ingest, emit done
```

`runtime.run()` returns a **`TurnHandle`**: await for `TurnResult`, iterate `.events`, pipe `toUIMessageStreamResponse()` for web (`useChat`, no bridge), or `toResponseStream('sse')` for raw `HarnessStreamPart` JSON-SSE.

## hostLoop composition

`hostLoop` decides what runs this turn:

| Condition | Action |
|-----------|--------|
| Active flow in RunState | `runFlow` over current node |
| Pure dispatcher (routes/agents, no answering surface) | Silent model classify → enter flow or transfer |
| Answering agent (instructions/flows/tools…) | Speaking turn with `enter_flow`/`transfer_to_agent` tools + concurrent guard |
| No host targets | Free conversation via `ChannelDriver` |
| Handoff requested | Loop up to `maxHandoffs` |

Behavior derives from shape: a routes/agents-only agent is a silent pure dispatcher; an answering agent folds host-control tools + a guard into its turn.

## runFlow and node kinds

`runFlow` interprets four node kinds:

| Kind | Job |
|------|-----|
| `reply` | LLM turn + tools; `next(turn, state)` returns transition |
| `collect` | Multi-turn schema gather via `collectUntilComplete` |
| `action` | Deterministic step; `run(state, ctx)` — no LLM |
| `decide` | Structured branch via `decide(data, state)` |

Transitions are **returned** from handlers — `{ goto, data }`, `{ handoff }`, `{ end }`, or `'stay'`.

## Effect log and exactly-once tools

Side-effecting tools register in `tools` and execute through `ctx.tool`:

```ts
const charge = defineTool({
  name: 'charge',
  input: z.object({ orderId: z.string() }),
  execute: async (args, ctx) => billing.charge(args),
});

defineAgent({
  id: 'checkout',
  tools: { charge },
  tools: buildToolSet({ charge }),
});
```

Recorded effects replay on crash, reconnect, or channel switch — handlers short-circuit on re-entry.

## ChannelDriver

Same agent definition, different drivers:

```ts
// Text (default)
runtime.run({ sessionId, input: 'Hello' });

// Voice
import { VoiceDriver } from '@kuralle-agents/core';
runtime.run({ sessionId, input: transcript, driver: new VoiceDriver({ ... }) });
```

Both paths use the same `hostLoop`, `runFlow`, `tools`, session store, and hooks.

## Derivation from field presence

`deriveAgent` (internal) maps `AgentConfig` fields to runtime capabilities:

- `flows[]` → flow dispatch
- `routes`/`agents` with no answering surface → silent pure dispatcher; with one → host-control tools + guard
- `handoffs` / nested `agents` → handoff targets
- `tools` → durable tool executor
- `guardrails` → input/output processors

No type tag — populate fields, behavior follows.

## Key hooks (observability)

| Hook | Fires |
|------|-------|
| `onStart` | Session opened |
| `onToolCall` / `onToolResult` | Tool execution |
| `onStreamPart` | Every stream event |
| `onHandoff` | Agent transfer |
| `onEnd` | Session closed |

Attach via `createRuntime({ hooks })` or per-agent `hooks`.

## Voice note: extractionModel

When using `collect` nodes in voice, set `extractionModel` on `createRuntime` so post-turn verification runs against the actual user transcript:

```ts
const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  extractionModel: openai('gpt-4o-mini'),
  voiceMode: true,
});
```

See `docs/skills/kuralle-voice-agents/rules/extraction-model-required.md`.
