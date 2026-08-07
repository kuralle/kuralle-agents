# Runtime Internals: `openRun` → `hostLoop` → `closeRun`

These are the internals behind `TextDriver`. You rarely call them directly — `createRuntime` wires them — but understanding them is essential for custom `ChannelDriver` implementations, custom hooks, and advanced observability.

## Turn lifecycle

Every `runtime.run()` follows one path:

```
openRun  → load session, RunState, effect log; replay recorded effects
hostLoop → route → runFlow → free converse → handoff loop
closeRun → persist RunState, run extractors if the trigger fires, emit done
```

`runtime.run()` returns a **`TurnHandle`**: await for `TurnResult`, iterate `.events`, pipe `toUIMessageStreamResponse()` for web (`useChat`, no bridge), or `toResponseStream('sse')` for raw `StreamPart` JSON-SSE.

## hostLoop composition

`hostLoop` decides what runs this turn:

| Condition | Action |
|-----------|--------|
| Active flow in RunState | `runFlow` over current node |
| Pure dispatcher (routes/agents, no answering surface) | Silent model classify → enter flow or transfer |
| Answering agent (instructions/flows/tools…) | Speaking turn with `enter_flow`/`transfer_to_agent` tools; a lazy guard classifies only when the turn produces no text and no control tool |
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

```ts
// Text (default)
runtime.run({ sessionId, input: 'Hello' });

// Custom driver — implement ChannelDriver and pass it explicitly
runtime.run({ sessionId, input, driver: myCustomDriver });
```

Every driver runs through the same `hostLoop`, `runFlow`, `tools`, session store, and hooks.

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
| `onStart` | Turn started |
| `onStreamPart` | Every stream event |
| `onConversationEnd` | Session-level outcome recorded |
| `onError` | Turn threw |
| `onEnd` | Turn finished |

Attach via `createRuntime({ hooks })` or per-agent `hooks`.

## Voice notes: transcriptionModel

Set `transcriptionModel` on `createRuntime` so inbound audio `FilePart`s (voice notes) are
transcribed to text before the model turn — this lets `collect` nodes and post-turn verification
run against the actual transcript even on text-only models:

```ts
const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  transcriptionModel: openai.transcription('whisper-1'),
});
```

