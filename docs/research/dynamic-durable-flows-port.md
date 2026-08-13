# Dynamic + durable flows for Kuralle — port design from Mastra (with BotCircuits/Argus lessons)

Status: Ready for review — research synthesis, pre-RFC.
Date: 2026-08-13.
Sources: Mastra monorepo at source level (PRs #19492 / #20471 code), `botcircuits-agent`, `botcircuits-argus`, and a full map of Kuralle's flow/runtime internals.

## 1. The decision in one paragraph

Do not add a second "workflow" primitive next to `Flow`. `Flow` **is** Kuralle's workflow.
Port the Mastra design as a **declarative dialect of `Flow`**: a JSON `FlowDefinition` that rehydrates
into a normal `Flow` through the existing interpreter (`runFlow`). Code-authored flows keep closures
and stay live-only. JSON-authored flows use the declarative subset and become storable, hot-registerable,
and durable. This mirrors Mastra exactly: closures remain legal but unserializable; serialization throws
loudly on them; predicates and mappings are the declarative replacements. One primitive, two dialects.

## 2. What Mastra actually built (mechanics that matter)

One pipeline, one home per concern:

```
build → toStorableGraph(stepFlow) → validate → persist → rehydrateWorkflow → addWorkflow
```

- **Serialized union** (`SerializedStepFlowEntry`): agent / tool / mapping / workflow / parallel /
  conditional / loop / foreach / sleep / sleepUntil. Call-site `id` is distinct from registry
  `agentId`/`toolId`/`workflowId`.
- **Predicate DSL**: `eq/ne/lt/lte/gt/gte`, `in/notIn`, `exists/notExists`, `truthy/falsy`, `and/or/not`
  over paths rooted at `initData | inputData | state | stepResults.<id>`. Never throws at evaluation —
  a `MISSING` sentinel propagates; unknown scope → false-ish, `notIn` with missing → true.
  The engine never sees predicates: `predicateToCondition` converts to the closure shape the engine
  already accepts. Zero engine changes.
- **Mapping entries**: per-key exactly one of `value | template | requestContextPath | path`.
  Templates are `${namespace.path}` strings with a definition-time validator and a runtime resolver.
- **Validation core**: `validateDynamicWorkflow(def, index) → WorkflowValidationIssue[]` (collect mode);
  `assertValidDynamicWorkflow` is a 6-line throwing wrapper. Issues carry dotted graph paths
  (`graph.2.steps.0`) and machine-applicable **repair actions** with `legalSources`. Schema-flow analysis
  is a fold that types the graph end to end with a three-valued result: `compatible | incompatible | unknown` —
  only provable mismatches error. Registry index is gated per kind: absent key = skip checks (no false
  positives when the caller can't enumerate).
- **Strict at save, lenient at boot**: one option (`onUnsupportedSchema: 'throw' | 'warn'`) threaded
  through the JSON-Schema→Zod converter. One corrupt row cannot sink startup; one bad new row cannot
  reach storage. Per-row try/catch at boot.
- **Atomic bundles**: validate the whole set against `registry ∪ bundle`, topologically order by extracted
  nested-refs, snapshot registry slots, register all, persist last, roll back registry on any failure.
  Residual window: partially-written rows on storage failure (inert until reboot) — documented honestly.
- **Storage domain**: `mastra_workflow_definitions` row = id, description, metadata, 4 JSON schemas,
  graph (jsonb), status `active|archived`, source, authorId, timestamps. `insertOnly` on create so a
  concurrent create is a key violation, not a clobber. No versioning in v1 (acknowledged gap).
- **Durability**: every run snapshot **embeds `serializedStepGraph`** — in-flight runs keep their graph
  when a definition is replaced; `timeTravel()` diffs against it (hence deterministic mapping ids).
  The whole durable-engine seam is one overridable method: `wrapDurableOperation(operationId, fn)` where
  `operationId = (workflowId, runId, executionPath, phase)`. Two write modes: whole-snapshot persist
  (default engine) and per-step merge writes (evented engine, concurrent-safe).
- **Agent authoring is first-class**: a 54 KB authoring playbook lives in core, composed as
  `shared contract + surface policy`; the builder agent gets exactly four tools (3 discovery + 1 save).
  Wire dialect normalizer strips `null` only at declared-optional slots (OpenAI strict-schema concession).
- **Compile-time drift guards** between the three unions (canonical / validatable / authoring) via
  `Expect<Extends<...>>` type assertions.

Their mistakes to not repeat: `mapConfig` as a JSON string inside JSON (double encoding); hand-rolled
JSON-Schema→Zod MVP with a large unsupported set; wire Zod schema duplicated in the server package;
half-implemented `archived`; no versioning; `Workflow` class thenable because of a builder method named
`.then()` (forces `{ workflow }` wrapper); 4,700-line workflow.ts.

## 3. Kuralle current state (what the map found)

- A flow is ~40% data / 60% closures. Required closures: `ActionNode.run`, `CollectNode.onComplete`,
  `DecideNode.decide`; optional ones on reply (`response`, `next`, fn-`instructions`, fn-`tools`,
  `grounding.query`, `verify.check`). `confirmGate` decide is the only fully-declarative node today.
  `defineFlow` is an identity function — zero validation, no schema, no digest.
- `Transition` admits inline node objects and thunks. A run parked on an inline node not in `flow.nodes`
  **cannot resume** (registry rebuilt from `flow.nodes` only; `runFlow.ts:414` throws).
- Runtime registry (`agentsById`) is frozen at construction. But `deploymentRouter.ts:143` already
  builds a runtime per request from a stored artifact — agents already change without redeploy.
  **Flows are the only primitive still bound as code references** (`AgentArtifactV1.flows:
  CapabilityReference[]` resolved from a boot-time `VersionedRegistry<Flow>`). Tools already have
  data-defined kinds (http/mcp/builtin/client) — the template to follow.
- Durability: the effect journal (`replayOrExecute`, `StepRecord`, idempotency keys, signal pauses)
  is **stronger than Mastra's** (exactly-once tool effects; Mastra has none of that). But:
  - `sessionDerivedRunId(sessionId) => sessionId` — one run per session, no headless runs, no
    concurrency, no external run addressing. The persisted map (`SessionDurableRuns`) already supports
    N runs; only one key is ever written.
  - `openRun` bumps `runEpoch` and prunes the journal on every fresh user turn — wrong for a workflow
    spanning many turns.
  - Only `RunStore` impl is `SessionRunStore`: every step append is a full-session read-modify-write
    (transcript included), 8 CAS retries. No run-status index, no "list paused runs", no crash sweeper.
  - Nothing pins a flow version on `RunState`. `activeFlow`/`activeNode` are bare strings resolved
    against whatever the process holds. Effect keys namespace by flow *name*, so a redefined flow
    replays the old version's results. No analogue of `assertResumableEffectKeys` for flow drift.
- Live-mutation precedent to reuse: `LiveSkillCatalog` + `ctx.addSkill/removeSkill` (serialized into
  run state, announced via tagged system note, crash-safe re-diff).

## 4. The `FlowDefinition` dialect (proposed)

JSON Schema everywhere on the wire; convert to the internal schema representation at registration
(same strict/lenient knob as Mastra).

```jsonc
{
  "name": "refund-flow",
  "description": "…",
  "inputSchema": { /* JSON Schema — FlowStateBoundary.input replacement */ },
  "outputSchema": { /* JSON Schema — FlowStateBoundary.output replacement */ },
  "start": "greet",
  "nodes": [ /* declarative node union, discriminated by kind */ ]
}
```

Node dialects (declarative replacements for each closure):

| Node | Closure today | Declarative form |
|---|---|---|
| `reply` | `response(state)`, fn-instructions, `next(turn,state)` | `instructions: template`; `response: { template }` (engine-rendered, verbatim — the Argus zero-token idea) **or** `generate: true` (LLM-rendered); `next: TransitionRef` or `routes: [{ when: Predicate, to: TransitionRef }]` |
| `collect` | `onComplete(data,state)` (required), `ask`, `instructions` | `schema: JSON Schema`; `ask/instructions: template`; `assign: { "<statePath>": "<collectedField>" }`; `next: TransitionRef`. Extraction gets the Argus tier stack (see §7) |
| `action` | `run(state, ctx)` — arbitrary code, full ctx authority | `tool: toolId`; `args: MappingConfig` (Mastra's per-key `value|template|path` object — **an object, not a JSON string**); `bind: "<statePath>"`; `approval?: true` (maps to `ctx.approve`); `next / routes` |
| `decide` | `decide(data,state)` | `choices` (already data) + `routes: [{ when: Predicate, to }]` + `otherwise: TransitionRef`; `confirmGate` already declarative — keep as-is |

`TransitionRef` is the serializable subset of `Transition`: `{ goto } | { handoff } | { escalate } | { end } | 'stay'` —
**by node id only**. Inline nodes and thunks are excluded from the dialect (they are also the current
resume-breaking bug; fix that independently).

Adopt Mastra's `Predicate` DSL verbatim (it is the best-designed piece — MISSING-sentinel semantics,
never-throws-at-eval, engine-invisible). Roots for Kuralle: `input | state | results.<nodeId> | requestContext`.

`toStorableFlow(flow)` is the reverse direction: walks a code-authored `Flow` and throws with an
actionable message on any closure field. Never lose data silently.

## 5. Validation core (copy the shape wholesale)

- `validateFlowDefinition(def, index) → FlowValidationIssue[]` — collect mode is the core.
  `assertValidFlowDefinition` throws; it is presentation only.
- Issue = `{ code, path, message, repair? }` with dotted paths (`nodes.2.routes.0.when`).
- Registry index gated per kind (`tools?`, `flows?`, `agents?` for handoff targets): absent key skips
  that check class. Index both registration key and canonical id.
- Checks: structure (ids unique, start exists, transitions resolve, no unreachable nodes),
  references (toolId exists — with the misclassification hint pattern), schema flow (three-valued
  compatibility folding state through the graph; `collect.schema` and `action.bind` type the state),
  predicate path scoping (only preceding nodes, paths exist in known schemas), template syntax
  (including the `{{...}}`-vs-`${...}` trap detection).
- Repair actions with `legalSources` from day one — this is what makes LLM authors self-correct in
  one turn. Never advertise a container/aggregate id as a mapping source.
- Compile-time drift guards between canonical/validatable/authoring unions (`Expect<Extends<…>>`).
- Zod schemas for the wire live in **core** and are imported by hono-server — never duplicated.

## 6. Registration lifecycle, storage, HTTP

- **Core**: `runtime.addDynamicFlows(defs, { agentId })` with Mastra's atomic-bundle algorithm:
  duplicate guard → normalize wire dialect → validate all against `registry ∪ bundle` → topo-order →
  snapshot registry slots → register all → persist last → rollback registry on failure. Prefer a
  transactional multi-row write where the backend allows it (close Mastra's partial-write window).
- **Registry**: replace the three linear `agent.flows?.find(...)` lookups with a mutable, id-keyed
  `LiveFlowCatalog` (direct analogue of `LiveSkillCatalog`). The `enter_flow` tool enum and routing
  classifier already rebuild per turn — they pick up additions for free.
- **Storage domain**: `FlowDefinitionsStore` (`kuralle_flow_definitions`): id, description, schemas,
  nodes (jsonb), status, source, authorId, digest, timestamps. Backends day one per standing rule:
  Memory, Postgres, Redis, **DO SQLite via `SqlExecutor` (CF parity in the same sprint)**.
  `insertOnly` on create. Unlike Mastra: **immutable versions + an active pointer** from day one
  (upsert-in-place is unauditable when agents author flows; this was their acknowledged gap).
- **HTTP (hono-server)**: `GET/POST /api/stored/flows`, `GET/DELETE /api/stored/flows/:id`.
  Enforce via `Policy` at the boundary: `stored-flows:read` / `stored-flows:write` decisions,
  fitting the existing `Policy.decide(req)` model. Wire the same surface into cf-agent; DO-cached
  bound revisions need a generation bump on flow writes (the pin-key cache in `KuralleThreadAgent`).
- **Deployment artifact**: add an inline variant next to `CapabilityReference`:
  `flows: (CapabilityReference | FlowDefinition)[]` — exactly how http/mcp tool references already work.
  The binder validates + rehydrates inline definitions; `packageSkillsDirectory`-style packaging later.
- **Boot**: load `status: 'active'` definitions in dependency order; per-row try/catch; run the same
  collect-mode validator in warn mode (Mastra skips structural revalidation at boot — do better).

## 7. Durability (the part Mastra needed and Kuralle half-has)

Kuralle's effect journal already beats Mastra (exactly-once tool effects with idempotency keys —
Mastra re-runs effects and only checkpoints step boundaries). What must change:

1. **Run identity first** (the keystone; also fixes audited F4/F6). Kill `sessionDerivedRunId`:
   `runId = generateId()`, stored in `SessionDurableRuns[runId]` (the map already supports it).
   A session holds a *set* of runs; the chat turn loop owns one "conversation run"; flow runs get
   their own ids, addressable via `runtime.getRun(runId)` / `resume(runId, signal)`. Headless flow
   runs (no chat session) become possible.
2. **Stop pruning flow-run journals per turn.** `runEpoch` bump + `pruneStepsBeforeEpoch` applies to
   the conversation run only. A flow run's journal lives until the run reaches a terminal status.
3. **Run-scoped storage.** Extend `RunStore` with `listRuns(filter)`, `deleteRun`; add row-per-step
   backends (`PostgresRunStore`, DO-SQLite `SqlRunStore`) instead of whole-session read-modify-write.
   Keep `SessionRunStore` as the zero-config default. Add a status index → "list paused runs",
   deadline sweeper for `InterruptRequest.deadline`, crash recovery (scan `running` runs with no
   lease and resume-by-replay; the journal already makes replay correct — nothing calls back in today).
4. **Pin the flow into the run.** On flow entry, stamp `RunState.flowDigest` (canonical-JSON sha256 —
   `artifactDigest` machinery exists) and persist the rehydrated definition (or its digest + version id)
   with the run, exactly like Mastra embeds `serializedStepGraph`. Resume checks digest: match →
   continue; mismatch → structured `FlowDriftError` with the option to migrate or restart. Namespace
   effect keys by `flow@digest`, not flow name (closes the stale-replay hole).
5. **Deterministic node/step ids.** Synthesized ids (mapping ordinals etc.) must be restart-stable —
   they land in journals and are matched on resume/time-travel. Fix the inline-node resume bug by
   banning inline transition targets from the declarative dialect and registering them properly for
   the code dialect.
6. **Durability seam.** Adopt the `wrapDurableOperation(operationId, fn)` pattern with
   `operationId = (flowId, runId, nodePath, phase)` as the single overridable seam — this is what
   later lets a workerd/DO engine or an Inngest-style engine override persistence without touching
   the interpreter.

## 8. Lessons folded in from BotCircuits / Argus

Adopt:
- **Engine-rendered replies** (`flow.result` / template `response`): the final answer costs zero model
  output tokens and is verbatim-deterministic. Kuralle's `reply` gets an authored-vs-generated split.
- **Segments**: batch consecutive non-branching nodes into one LLM call — calls scale with branch
  points, not node count. Applies to chains of declarative `action`/`reply` nodes.
- **Tiered slot resolution for `collect`**: Tier 0 deterministic resolvers (enum/range/jsonpath, zero
  tokens) → Tier 1 a synthetic `record_slots` tool whose schema advertises *only this node's* fields →
  Tier 2 cheap-model extraction with a provenance guard (extracted value must appear in source text;
  never raises, returns `{}`). Explicit rule: **ambiguity = unresolved → clarify, never silently default**.
- **Decision provenance**: every routed transition records `{predicate, operands, slot_source:
  llm|deterministic, matched}` in the trace — routing becomes defensible, not just readable.
- **Build-time NL→predicate compilation** (optional authoring sugar): author writes a natural-language
  condition; a one-shot LLM call compiles it to the Predicate DSL at *save* time; runtime is fully
  deterministic. Pin model/prompt-hash into the stored definition (Argus didn't — builds are
  unreproducible).
- **Verification gates**: post-run checks generated from `outputSchema` + declared rubric; a check that
  *fails to execute* is always blocking; judges see an explicit input allow-list; keep every attempt's
  verdict; bounded non-configurable repair budget. Kuralle's durable journal makes repair safe where
  Argus re-ran side effects.
- **Cache-stable prompting as a tested invariant**: one immutable system prefix per run; all
  variability after it.

Avoid (observed failure modes):
- Session state in module globals / tool closures (their multi-user workflow bug).
- Prompt-nagging as the flow-advancement mechanism — Kuralle's runtime-driven `runFlow` already
  enforces structurally what they beg the model to do.
- Two live engines after an architecture inversion — when the declarative interpreter lands, there is
  exactly one `runFlow`.
- Publishing benchmarks without the harness.
- Silently-permanent permission grants from free-text replies — grants are run-scoped; persistence is
  an explicit separate action (Kuralle's `Policy`/`ask` already models this correctly).

## 9. Phasing (each phase independently shippable, no stopgaps)

- **P0 — Run identity + run storage** (prerequisite; independently fixes audited F4/F6):
  runId ≠ sessionId; journal-prune scoping; `RunStore.listRuns`; Postgres + DO-SQLite run stores;
  paused-run listing + deadline sweeper. Verification: concurrent two-run session test; kill-and-resume
  test across process restart on both Node and workerd.
- **P1 — Declarative dialect + validation + rehydration**: `FlowDefinition` types + Predicate DSL +
  mapping config; `validateFlowDefinition` (collect mode, repair actions); `rehydrateFlow` → `Flow`;
  `toStorableFlow` (strict, throwing); flow digest pinning on `RunState`. Verification: round-trip
  property tests (definition → rehydrate → serialize → deep-equal); drift-guard type assertions;
  live example under `packages/core/examples/` actually run.
- **P2 — Registration + storage + HTTP**: `FlowDefinitionsStore` (Memory/PG/Redis/DO-SQLite, versioned);
  `runtime.addDynamicFlows` atomic bundles; `LiveFlowCatalog`; hono-server + cf-agent routes behind
  `Policy` (`stored-flows:*`); deployment-artifact inline flows. Verification: bundle-atomicity tests
  (register-nothing-on-invalid, rollback-on-persist-failure); workerd parity test same sprint.
- **P3 — Authoring + optimization**: flow-builder playbook in core (shared contract + surface policy,
  3 discovery tools + 1 save tool); NL→predicate build compilation with pinned model hash; segments;
  tiered collect resolution; verification gates; engine-rendered replies.

## 10. Code dialect: what changes for TypeScript authors

Almost nothing breaks; the code blueprint is additive.

- `defineFlow` keeps its signature and keeps closures. Closure flows stay live-only, like Mastra's.
- `defineFlow` stops being an identity function. It runs the structural half of the validator
  (unique ids, resolvable transitions, reachable nodes) and computes the flow digest. Errors that
  today surface mid-run surface at definition time.
- **One migration**: inline node objects and thunks in `Transition` are removed from the authoring
  surface; targets must be registered nodes referenced by id. They already break resume for parked
  runs, and per our rules we migrate callers rather than keep the broken arm.
- New exports, all additive: `FlowDefinition`, `validateFlowDefinition`, `rehydrateFlow`,
  `toStorableFlow`, the `Predicate` helpers, `runtime.addDynamicFlows`.
- Run identity changes are internal (`RunState.flowDigest`, `runId` generation); `SessionStore` and
  stream event contracts are untouched.

## 11. File-authored agents and Agent Plugins

The declarative dialect is what makes flows travel in both file formats. Same validator core,
three presentations — matching the existing strictness philosophy exactly:

| Surface | Who authored it | Validation posture |
|---|---|---|
| File-authored agent (`kuralle build`) | you | **strict** — compiler rejects the build on any issue |
| Agent Plugin (`loadAgentPlugin`) | someone else | **isolate** — skip the bad flow, emit diagnostics, load the rest |
| HTTP `POST /api/stored/flows` | an agent or user, live | strict at save, lenient at boot |

**File-authored agents.** Add `flows/` to the agent folder next to `skills/`:

```text
agent/
  instructions.md
  agent.json
  flows/
    refund.flow.json      # declarative FlowDefinition
  skills/…
```

The compiler validates each definition in collect mode and fails the build on issues (you wrote it;
a mistake is a bug to stop). Compiled definitions land **inline in the artifact** via the
`flows: (CapabilityReference | FlowDefinition)[]` variant from §6, covered by the content digest.
The binder rehydrates them at bind time. TS flows keep shipping as capability references bound from
the code registry — unchanged. Result: a file-authored agent's behavior (instructions, skills, and
now flows) is fully declared in the folder; only tools, models, and stores stay host-supplied.

**Agent Plugins.** Flows become an optional plugin component beside `skills/` and `mcp.json`:

```text
my-plugin/
  plugin.json
  skills/…
  mcp.json
  flows/
    returns-escalation.flow.json
```

- Agent Plugins 1.0.0 does not define `flows/`; other hosts ignore unknown directories, so the
  plugin stays spec-portable — flows are a host capability, proposed as a spec extension alongside
  our conformance work.
- `loadAgentPlugin` gains a `flows` result field (analogous to the returned `SkillStoreLike`) and a
  **fifth failure width**: a bad flow file skips that flow with a `{ section: 'flows', rule, … }`
  diagnostic; siblings, skills, and MCP are untouched.
- Reference scoping does the security work: a plugin flow may reference only tools the host
  registered plus servers from the plugin's own `mcp.json`. The validator's gated registry index
  checks refs at load; a missing tool is a skipped flow + diagnostic, never a crash. `Policy`
  still gates every execution, so a plugin flow cannot exceed the host's tool boundary.
- Supply modes end up mirroring skills one-to-one: inline `defineFlow` (code) · packaged artifact
  (file-authored agent) · `fsFlowStore` discovery (plugins, `/.agents/flows`) · per-tenant
  `FlowResolver` · plus the DB-backed `FlowDefinitionsStore` for live HTTP registration.

## 12. Verification surface for the whole initiative

`bun run typecheck:all` green; new conformance suite `flow-definitions` shared across all stores
(Mastra's `_test-utils` pattern); a live end-to-end: POST a JSON flow to a running hono-server,
execute it, kill the process mid-`collect` pause, restart, resume by runId, assert exactly-once
effects and identical trace timeline. The same script runs against cf-agent on workerd.
