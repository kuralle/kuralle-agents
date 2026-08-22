# Verified API shapes

Signatures below were read from `packages/core/src/` in this repository. Confirm
against source before relying on a detail that matters — the file path is given
for each.

## `defineAgent`

`packages/core/src/types/agentConfig.ts`. Exported from `@kuralle-agents/core`.

```typescript
defineAgent({
  id: string,
  name?: string,
  description?: string,
  instructions?: Instructions,           // string | AgentPrompt | (ctx) => Instructions
  model?: LanguageModel,
  controlModel?: LanguageModel,          // deterministic routing / extraction model
  tools?: Record<string, AnyTool>,       // durable, model-callable effects
  globalTools?: Record<string, AnyTool>, // safe tools visible in every speaking node
  flows?: Flow[],
  routes?: Route[],
  routing?: RoutingPolicy,
  agents?: AgentConfig[],
  handoffs?: string[],                   // agent ids this agent may transfer to
  knowledge?: AgentKnowledge,
  memory?: AgentMemory,
  guardrails?: Guardrails,
  limits?: Limits,
  validate?: ValidationCapability[],
  refine?: RefinementCapability[],
  policy?: Policy,
  workspace?: AgentWorkspaceConfig,
  skills?: SkillSource,
})
```

Behavior is derived from populated fields:

| Populate | The agent becomes |
|---|---|
| `tools` | A durable tool-calling agent |
| `flows` | A structured flow agent |
| `routes` + `routing` | A triage router |
| `agents` + `handoffs` | A composition wrapper |
| `workspace` + `skills` | A file-native, progressively instructed agent |

These combine. One agent can hold tools, a flow, and routes at once.

`controlModel` defaults to `model`. Set it to pin routing, decisions, and
extraction to a deterministic model independent of the speaking model.

`knowledge.autoRetrieve` declares who invokes retrieval, not whether retrieval
exists. `true` (the default) pre-injects snippets into the system prompt before
every answering turn. `false` skips pre-injection and wires a `knowledge_search`
tool the model calls on its own. The two are mutually exclusive. Omit
`knowledge` to disable retrieval.

## `defineTool`

`packages/core/src/tools/effect/defineTool.ts`.

```typescript
defineTool({
  name?: string,
  description: string,                   // required
  input?: ZodSchema | StandardSchemaV1,
  output?: …,
  execute: (args, ctx?) => Promise<R> | AsyncIterable<R>,   // required
  needsApproval?: boolean,               // sugar for a policy returning `ask`
  interruptible?: boolean,
  interim?: string,                      // text shown while the tool runs
  interimAfterMs?: number,
  timeoutMs?: number,
  replay?: boolean,
  parallelSafe?: boolean | ((args) => boolean),
  idempotencyKey?: (args) => string,
})
```

`filler` and `estimatedDurationMs` are deprecated aliases of `interim` and
`interimAfterMs`.

`parallelSafe` is never model-controlled. Only the tool author asserts it. The
function form receives raw, unvalidated model args and must not throw; a throw or
a non-boolean return is treated as not parallel-safe.

Return an `AsyncIterable` from `execute` to stream progress.

Pass the tool record to `defineAgent({ tools })`. The runtime derives the AI SDK
`ToolSet` and routes every call through the durable effect log. Convert a raw AI
SDK tool with `wrapAiSdkTool()` before it enters either record.

### Control results

Ordinary tools return data. Two helpers return text the model reads to decide
what to say next:

```typescript
import { toolDeniedResult, toolErrorResult } from '@kuralle-agents/core';
```

Produce them with these helpers rather than hand-rolling the shape. The
`__denied` marker is load-bearing inside `core`.

### Durability

A finished effect-log step replays without re-executing. A crash between execute
and finalize re-runs the effect, so an external side effect must honour the
idempotency key. The guarantee is exactly-once modulo idempotency, not
exactly-once.

## `defineFlow` and node builders

`packages/core/src/types/flow.ts`.

```typescript
defineFlow({
  name: string,
  description?: string,
  start: Node,      // entered on the first turn
  nodes: Node[],    // every node in the flow
})
```

`defineFlow` validates the graph at definition time and throws with the full
issue list. It rejects a transition target that is a thunk (`() => node`) or a
node object missing from `nodes` (`inline-transition-target`), unreachable
nodes, and a `start` missing from `nodes`. An inline target has no stable
identity for a parked run to resume against.

| Builder | Job |
|---|---|
| `reply(node)` | Speak, then transition. `next` is optional; omit it to stay. |
| `collect(node)` | Fill a schema over one or more turns. Never speaks model text. |
| `action(node)` | Run a side effect with no user-facing reply, then transition. |
| `decide(node)` | Ask the model for a structured decision, then branch. Requires `schema` and `decide`. |
| `confirmGate(node)` | A `decide` node preset for confirm / decline / ambiguous. |

`reply` accepts `response: (state) => string` for transactional text that must
not be model-authored. The engine emits it verbatim with no model call and marks
the turn `rendered: 'engine'`.

`collect` re-enters until every `required` field is filled, up to `maxTurns`
(default 10). The user-facing question is the deterministic `ask(missing, state)`
— optional `instructions(missing, state)` steers extraction only and is never
shown. `resolvers` resolves individual fields deterministically and excludes them
from the model's extraction schema. `verbatimFields` drops a model-extracted
value when the user's turn does not contain it; guard only quoted fields such as
an account id, never fields extraction is meant to rewrite.

### Transitions

A `next` or `onComplete` function returns a `Transition`:

| Return value | Effect |
|---|---|
| A node object registered in `nodes` | Move to that node next turn |
| `{ goto: 'nodeId', data? }` | Move by id, merging `data` into flow state |
| `{ end: 'label' }` | End the flow with a label |
| `{ handoff: 'agentId', reason? }` | Hand off to another agent |
| `{ escalate: 'reason' }` | Escalate to a human |
| `'stay'` | Stay on this node another turn |

## `createRuntime`

`packages/core/src/runtime/Runtime.ts`. `HarnessConfig` is the runtime-wide
default layer; `AgentConfig` overrides it per agent.

```typescript
createRuntime({
  agents: AgentConfig[],                 // required
  defaultAgentId: string,                // required
  sessionStore?: SessionStore,           // defaults to in-process MemoryStore
  defaultModel?: LanguageModel,
  tools?: Record<string, AnyTool>,
  driver?: ChannelDriver,
  knowledge?: KnowledgeProviderConfig,
  policy?: Policy,
  hooks?: Hooks,
  maxHandoffs?: number,
  terminalHandoffTargets?: string[],
  silentHandoff?: boolean,               // default true
  handoffInputFilter?: HandoffInputFilter,
  compaction?: CompactionConfig,
  escalation?: EscalationConfig,
  transcriptionModel?: TranscriptionModel,
  defaultWorkingMemoryStore?: PersistentMemoryStore,
  extractedValueStore?: ExtractedValueStore,
  trackGoals?: boolean,                  // default off
})
```

Set `policy` on `HarnessConfig` for a runtime default, and on `AgentConfig` when
one agent needs its own — which is what a delegated read-only worker needs.

## `runtime.run` and `TurnHandle`

`RunOptions` (`Runtime.ts`) — the fields you reach for most:

```typescript
runtime.run({
  input?: UserInputContent,   // text, or AI SDK multimodal parts
  sessionId?: string,
  userId?: string,
  agentId?: string,
  runId?: string,             // resume an existing run; cross-session values fail closed
  kind?: 'flow',              // mint a new headless flow run with its own journal
  wake?: WakeOptions,         // proactive turn — mutually exclusive with `input`
  callerInstructions?: string,
})
```

`TurnHandle` (`packages/core/src/types/stream.ts`) extends
`Promise<TurnResult>`:

```typescript
interface TurnHandle extends Promise<TurnResult> {
  readonly events: AsyncIterable<StreamPart>;   // a property, not a method
  readonly runId: Promise<string>;              // resolves when the run opens
  toResponseStream(format?: 'sse' | 'ndjson'): ReadableStream;
  toUIMessageStreamResponse(opts?: { sessionId?: string }): Response;
  cancel(reason?: string): void;
}
```

`runId` resolves before the turn body finishes, so a caller minting
`kind: 'flow'` can persist the id it must resume with even if the turn throws.

Do not confuse `TurnHandle` with `RunHandle` — `RunHandle` is the run descriptor
(`runId`, `status`, `activeFlow`, `activeNode`, `waitingFor`).

### Stream events

| Event type | When | Key fields |
|---|---|---|
| `text-start` | Assistant message begins | `payload.id` |
| `text-delta` | Each text chunk | `payload.id`, `payload.delta` |
| `text-end` | Message complete | `payload.id` |
| `text-cancel` | Partial message retracted by a gate | `payload.id`, `payload.reason` |
| `tool-call` | Before a tool executes | `payload.toolName`, `payload.args` |
| `tool-result` | After a tool executes | `payload.toolName`, `payload.result` |
| `done` | Turn complete | `payload.sessionId` |

Save `payload.sessionId` from `done` and pass it back to continue the session.
The runtime assigns one on the first turn.

For a web UI, `POST /api/chat/sse` on `@kuralle-agents/hono-server` returns a
native AI SDK `UIMessageStream`. Point `useChat<KuralleUIMessage>` at it — no
bridge. Append `?format=raw` for raw `StreamPart` JSON-SSE.
