# Flow Definitions (JSON dialect, dynamic registration)

## Contents

- What a `FlowDefinition` is
- Node kinds
- `TransitionRef`
- Predicate DSL
- `MappingConfig` and `${...}` templates
- Gates
- Validation and repair
- Register at runtime
- Versioned stores
- HTTP surface
- Supply modes
- Authoring agent
- Digest pinning (`FlowDriftError`)

## What a `FlowDefinition` is

`FlowDefinition` is the JSON dialect for flows — the same `reply`/`collect`/`action`/`decide` graph as `defineFlow`, but pure data. It validates with `validateFlowDefinition`, registers live with `runtime.addDynamicFlows`, and persists in a versioned `FlowDefinitionsStore`. Schemas are JSON Schema (`JsonSchema`), not zod.

```ts
import type { FlowDefinition } from '@kuralle-agents/core';

const refund: FlowDefinition = {
  name: 'refund',
  description: 'Handle a refund request',
  start: 'collect_order',
  nodes: [
    {
      kind: 'collect',
      id: 'collect_order',
      schema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
      required: ['orderId'],
      next: { goto: 'lookup' },
    },
    {
      kind: 'action',
      id: 'lookup',
      tool: 'lookup_order',
      args: { orderId: { path: 'state.orderId' } },
      routes: [
        {
          when: { op: 'eq', left: { path: 'results.lookup.status' }, right: { literal: 'refundable' } },
          to: { goto: 'confirm' },
        },
      ],
      next: { end: 'not-refundable' },
    },
    {
      kind: 'reply',
      id: 'confirm',
      response: { template: 'Refunding order ${state.orderId}.' },
      next: { end: 'refunded' },
    },
  ],
};
```

## Node kinds

| kind | key fields |
|---|---|
| `reply` | exactly one of `response: { template }` (engine-rendered, never model-authored) or `generate: true` (model-authored); `instructions?`, `next?`, `routes?` |
| `collect` | `schema` (JSON Schema), `required?`, `ask?`, `assign?`, `resolvers?`, `maxTurns?`, `choices?`, `next?` |
| `action` | `tool` (by name on the agent's tool surface), `args?` (`MappingConfig`), `bind?`, `approval?: true`, `next?`, `routes?` |
| `decide` | `instructions?`, `schema?`, `choices?`, `routes?`, `otherwise?`, `confirmGate?` |

A reply node with both `response` and `generate`, or neither, fails validation (`invalid-reply`).

## `TransitionRef`

Transitions are by node **id** — the dialect has no inline nodes:

```
{ goto: '<nodeId>', data? } | { handoff: '<agentId>', reason? }
| { escalate: '<reason>' } | { end: '<outcome>' } | 'stay'
```

## Predicate DSL

`routes[].when` (and predicate gates) use a typed DSL over four path roots: `input`, `state`, `results.<nodeId>`, `requestContext`.

| op | shape |
|---|---|
| `eq` `ne` `lt` `lte` `gt` `gte` | `{ op, left, right }` — each side `{ path }` or `{ literal }` |
| `in` `notIn` | `{ op, value, set: [...] }` |
| `exists` `notExists` | `{ op, path }` |
| `truthy` `falsy` | `{ op, value }` |
| `and` `or` | `{ op, args: Predicate[] }` |
| `not` | `{ op, arg: Predicate }` |

Depth and size are capped (`PREDICATE_MAX_DEPTH` = 32, `PREDICATE_MAX_NODES` — both on the `@kuralle-agents/core/flows` subpath). `evaluatePredicate(predicate, ctx)` (root export) runs one; a missing path never throws — the comparison just fails.

## `MappingConfig` and `${...}` templates

`action.args` is a `MappingConfig`: `Record<string, MappingSource>` where each source is `{ value }` (literal), `{ path }` (scope lookup), or `{ template }` (string with `${path}` placeholders). Templates use the same four roots (`TEMPLATE_PATH_ROOTS`); `{{...}}` mustache syntax is rejected. `validateTemplateSyntax(template)` (on the `@kuralle-agents/core/flows` subpath) lint-checks one; `resolveMapping(config, scope)` (root export) resolves at run time. Reply `response.template` renders through the same engine.

## Gates

`gates` on a `FlowDefinition` (or a code `Flow`) run when the flow reaches a terminal transition:

- `{ id, kind: 'predicate', severity, when }` — evaluated against the run record.
- `{ id, kind: 'judge', severity, inputs, rubric? }` — `inputs` is an explicit allow-list of run-record paths (`input | state | results.<nodeId>`); requires `flowGateJudge` on `createRuntime` (a provider or a `LanguageModel`).

`severity` is `'blocking'` or `'advisory'`. A gate that **fails to execute** always blocks, even when declared advisory. A blocking failure ends the run with outcome `failed-verification`; verdicts land in the `FlowVerificationRecord`.

## Validation and repair

```ts
import { validateFlowDefinition, assertValidFlowDefinition } from '@kuralle-agents/core';

const issues = validateFlowDefinition(def, index); // FlowValidationIssue[]
assertValidFlowDefinition(def, index);             // throws with formatted issues
```

Each `FlowValidationIssue` is `{ code, path, message, repair? }`. `repair` is a machine-followable `FlowValidationRepairAction` — `operation` (`set-transition`, `set-mapping-source`, `set-predicate`, `set-template`, `update-node`, `remove-node`), `arguments`, and `legalSources` with schema compatibility. Issue codes include `duplicate-node-id`, `missing-start`, `unresolved-transition`, `unreachable-node`, `invalid-reply`, `missing-reference`, `incompatible-schema`, `invalid-template`, `predicate-too-deep`, `invalid-gate`. The `index` (`FlowRegistryIndex`) names the tools and flows references may resolve against.

## Register at runtime

```ts
await runtime.addDynamicFlows(defs, { agentId: 'support', replace: true });
await runtime.loadDynamicFlows({ agentId: 'support' });   // boot: load status:'active' rows
await runtime.removeDynamicFlow('refund', { agentId: 'support' });
```

- `addDynamicFlows(defs, { agentId, store?, replace?, compiler? })` registers a bundle atomically: every definition validates against the agent's tool surface and flow registry before any registers; on failure the in-memory catalog rolls back and persisted rows are compensated.
- Reusing an existing dynamic name is rejected unless `replace: true`. A code-configured name (`defineAgent.flows`) can never be replaced.
- Persist versions by passing `store` per call, or set `flowDefinitionsStore` on `createRuntime` as the default.
- `loadDynamicFlows` skips invalid rows with a warning — one corrupt definition cannot sink boot.

## Versioned stores

`FlowDefinitionsStore` keeps immutable versions with one active version per name.

- `MemoryFlowDefinitionsStore` — core, dev only
- `PostgresFlowDefinitionsStore` — `@kuralle-agents/postgres-store`
- `RedisFlowDefinitionsStore` — `@kuralle-agents/redis-store`
- `SqlFlowDefinitionsStore` — `@kuralle-agents/cf-agent` (Durable Object SQLite)

## HTTP surface

`createStoredFlowsRouter` (`@kuralle-agents/hono-server`) and the cf-agent equivalent serve `GET/POST/DELETE /api/stored/flows`. Authorization reuses `Policy`: decisions are requested as `stored-flows:read` (GET) and `stored-flows:write` (POST/DELETE). No policy means **allow** (the dev-router posture) — production hosts must pass one. `ask` has no HITL path on this surface and is treated as deny (403).

## Supply modes

- **File-authored agent folder** — top-level `flows/*.flow.json` beside `flows/*.ts`; `kuralle build` embeds them with the compiled flows.
- **Agent Plugin** — a `flows/` directory of `*.flow.json` files; an invalid file becomes a diagnostic, not a crash.

## Authoring agent

```ts
import { createFlowBuilderAgent, FLOW_BUILDER_AUTHORING_PLAYBOOK } from '@kuralle-agents/core';

const builder = createFlowBuilderAgent({
  id: 'flow-builder',
  model,
  surfaceInstructions: 'Only author flows for the support agent.',
  host, // FlowBuilderHost: save/list/validate against your store
});
```

`FLOW_BUILDER_AUTHORING_PLAYBOOK` is composed into the agent's instructions ahead of your `surfaceInstructions`. Authoring definitions (`AuthoringFlowDefinition`) may write `when: { nl: '...' }` instead of a DSL predicate; NL predicates compile to the DSL at save time, with provenance pinned on the stored version (compiler model id, prompt hash, compiler version). The `compiler` defaults to the agent's model.

## Digest pinning (`FlowDriftError`)

A run parked inside a flow pins the flow's digest. If the definition is redefined before resume, the resume throws `FlowDriftError` — carrying `runId`, `flowName`, `parkedNode`, `expectedDigest`, `actualDigest`, and `recovery: ['restart', 'abandon']` — instead of silently resuming against the new graph. Restart the run or abandon it; never patch around the error.
