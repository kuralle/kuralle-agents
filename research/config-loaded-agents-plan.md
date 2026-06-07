# Config-Loaded Agents + UI Builder — Plan

> Status: Draft (lead architect). Grounded against the Kuralle source as of 0.5.0.
> Companion: deploy primitives are covered by a **separate parallel plan** (referenced in §6).

## 1. Executive summary

The one core idea: introduce a **serializable `AgentOverlay`** — a JSON document that carries
only the data-shaped fields of `defineAgent` (id, name, description, instructions, routes,
routing, handoffs, knowledge, memory, guardrails, limits, and *references* to already-registered
tools/flows/capabilities). The runtime keeps holding the non-serializable parts in code (model
bindings, `tool.execute`, flow node functions, validate/refine functions). At run time, the
runtime **merges the overlay onto the code-defined base agent** at the existing agent-lookup seam.

A small **ConfigStore** (a new interface, with a Postgres/Redis-backed implementation reusing the
exact backends we already ship for sessions) persists overlays as **immutable, versioned
snapshots** with a draft/publish pointer. A **UI agent-builder** is *just a client* of a thin REST
config API over that store — it edits the serializable subset, nothing else. Its "Deploy" button
has two distinct meanings: **Publish config** (flip the published-version pointer; takes effect on
the next turn with no redeploy) and **Deploy app** (ship the host process; delegates to the deploy
primitives plan). This mirrors Mastra's "code skeleton + config overlay + versioned storage" split
without importing Mastra's storage-domain or REST-contract machinery.

## 2. The hard constraint: what can be config vs. what must stay code

Kuralle is code-first: `defineAgent(config: AgentConfig)` is an identity pass-through
(`packages/kuralle-core/src/types/agentConfig.ts:53-55`). The `AgentConfig` interface
(`agentConfig.ts:16-51`) mixes serializable data with live object references and functions. The
overlay can only touch the former. Exact split, by field:

### Serializable — the UI may edit (overlay-eligible)
| Field | Line | Notes |
|---|---|---|
| `id` | `agentConfig.ts:17` | Identity key; overlay is keyed by this, not editable. |
| `name` | `:18` | Plain string. |
| `description` | `:19` | Plain string. |
| `instructions` | `:20` | **Only** the `string` arm of `Instructions` (`:11-14`). The `AgentPrompt` and `(ctx)=>…` arms are code. |
| `routes` | `:35` | `Route[]` = `{ agent?, when, filter? }`; `when` is plain data, but `filter?: HandoffInputFilter` is a fn → overlay carries route text only, not `filter`. |
| `routing` | `:36` | `RoutingPolicy` `{ mode, default, always }` is data; its `model?` is a code ref (see below). |
| `handoffs` | `:38` | `string[]`. |
| `knowledge` | `:39` | `{ autoRetrieve?, sources?: string[] }` — pure data (provider instantiated in code). |
| `memory` | `:40` | `{ preload?, ingest? }` — pure data. |
| `guardrails` | `:41` | Rules/policies as data. |
| `limits` | `:42` | `{ maxTurns, maxSteps, … }` — pure data. |
| `experimental.outOfBandControl` | `:47-50` | boolean flag. |

### Must stay code — referenced by name from the overlay, never inlined
| Field | Line | Why it can't serialize |
|---|---|---|
| `model` | `agentConfig.ts:21` | `LanguageModel` object (AI SDK instance + provider key). |
| `controlModel` | `:25` | Same. |
| `tools` (model-visible schema set) | `:26` | Derived from `buildToolSet()`; the executor is stripped into a WeakMap, not serializable. |
| `effectTools` | `:27` | `AnyTool` with `execute()` fn. |
| `globalTools` | `:28-33` | `AnyTool` with `execute()` fn. |
| `flows` | `:34` | `Flow` nodes carry `next/onComplete/run/decide` functions. **Node graph shape is data; the callbacks are not** — so flows are referenced by name, defined in code. |
| `validate` | `:44` | `ValidationCapability` objects with `validate()` fn. |
| `refine` | `:46` | `RefinementCapability` objects with `refine()` fn. |
| `agents` (nested) | `:37` | Nested `AgentConfig[]` — each resolved through the same overlay/base merge; not inlined. |

**Implication for the UI:** the builder edits the left table directly, and for the right table it
offers **enable/disable + ordering of things the code already registered** (toggle a tool into
`tools`/`globalTools`, pick a flow by name, toggle a validator), never authoring new executors.
This is the line that keeps us from over-abstracting into a visual programming tool.

## 3. Primitive A — `AgentOverlay` schema + ConfigStore + runtime loader seam

### 3a. The schema (serializable overlay)
A Zod schema in core, `AgentOverlay`, with the §2 left-table fields **plus reference arrays** that
name code-registered resources:

```ts
// packages/kuralle-core/src/config/AgentOverlay.ts (new)
interface AgentOverlay {
  id: string;
  name?: string; description?: string;
  instructions?: string;                 // string-only arm
  routes?: { agent?: string; when: string }[];   // no filter fn
  routing?: { mode?: 'structured'|'llm'; default?: string; always?: boolean };
  handoffs?: string[];
  knowledge?: AgentKnowledge; memory?: AgentMemory;
  guardrails?: Guardrails; limits?: Limits;
  experimental?: { outOfBandControl?: boolean };
  // references into code-registered resources (by name):
  toolRefs?: string[];        // names of tools to expose in `tools`
  globalToolRefs?: string[];  // names → `globalTools`
  flowRefs?: string[];        // names → `flows`
  validateRefs?: string[]; refineRefs?: string[];
}
```

The host keeps a **code-side registry** of the non-serializable resources (the same objects it
defines today), e.g. `defineAgentBase({ id, model, tools, flows, validate, … })`. Merge =
`{ ...base, ...overlayDataFields, tools: pick(base.toolRegistry, overlay.toolRefs), … }`.

### 3b. ConfigStore — reuse our existing storage backends
Do **not** invent a new storage abstraction (this is exactly Mastra's
`MastraCompositeStore` coupling we want to avoid). Add a tiny interface, with concrete
implementations that reuse the *same* Postgres/Redis packages we already ship for sessions
(`packages/kuralle-postgres-store`, `packages/kuralle-redis-store`; the `SessionStore` interface is
at `packages/kuralle-core/src/session/SessionStore.ts:9-18` and MemoryStore is the default):

```ts
// packages/kuralle-core/src/config/ConfigStore.ts (new)
interface ConfigStore {
  getPublished(agentId: string): Promise<AgentOverlay | null>;
  getVersion(agentId: string, versionId: string): Promise<AgentOverlay | null>;
  getDraft(agentId: string): Promise<AgentOverlay | null>;
  listVersions(agentId: string): Promise<VersionMeta[]>;
  saveDraft(agentId: string, overlay: AgentOverlay): Promise<VersionMeta>; // immutable snapshot
  publish(agentId: string, versionId: string): Promise<void>;             // move pointer
}
```
Default = an in-memory `MemoryConfigStore`; production = a Postgres table
`agent_overlays(agent_id, version_id, status, message, created_at, body jsonb)` added to the
existing `kuralle-postgres-store` package (one migration, no new dependency).

### 3c. Runtime loader seam (the one place we change)
Today agent resolution is a **synchronous Map lookup** at
`packages/kuralle-core/src/runtime/openRun.ts:105`:
```ts
const agent = agentsById.get(runState.activeAgentId);   // openRun.ts:105
```
`agentsById` is built by `indexAgents(config.agents)` — the standalone function at
`packages/kuralle-core/src/runtime/Runtime.ts:360`, called from the constructor at
`Runtime.ts:80`. `createRuntime()` is at `Runtime.ts:356`.

Plan:
1. Add `configStore?: ConfigStore` to `HarnessConfig` (`Runtime.ts:41-54`).
2. Keep `indexAgents` as the **base** registry (unchanged; this holds the code parts).
3. After the lookup at `openRun.ts:105`, if a `configStore` is present and the active version
   selector resolves an overlay, **merge overlay onto base** before returning `agent`. The merge
   is pure data + name-resolution against the base's registries (model/tools/flows stay from base).
   This is one `await configStore.getPublished(activeAgentId)` (or version-pinned — §4) inserted at
   a seam that is already `async` (`openRun` is `async`, `openRun.ts:37`), so no signature churn in
   `Runtime.run`.
4. If no `configStore`, behavior is byte-for-byte identical to today (zero overhead, opt-in).

This is the *minimal* version of the brief's "ConfigRegistry": no FlowRegistry/CapabilityRegistry
object hierarchy — just one store call + a pure merge, because the code-side base agent already *is*
the registry.

## 4. Primitive B — versioning (draft/publish, immutable snapshots, selection)

Steal the Mastra model, keep it to the four moves we actually need:

- **Draft/Publish.** `saveDraft()` writes a new immutable snapshot row with `status='draft'`;
  `publish(versionId)` flips the `status='published'` pointer for that `agent_id`. Past published
  rows become `status='archived'` (kept for rollback). Mirrors Mastra's draft→publish.
- **Immutable snapshots.** Each save is a new `version_id` (uuid); rows are never mutated. Optional
  `message` column = Mastra's "change message".
- **Version selection at run time.** `RunOptions` gains an optional
  `overlayVersion?: { status: 'published'|'draft' } | { versionId: string }` (default
  `{status:'published'}`). At the §3c seam, this picks which `ConfigStore` getter to call — the
  Kuralle analogue of Mastra's `getAgentById(id, { status | versionId })`. This is what enables
  A/B (route by version) and one-click rollback (publish an older `versionId`).

Explicitly **out of scope** for v1: the full visual rules-engine "display conditions"
(`requestContext`-gated tool/prompt visibility). Kuralle already has a code-side equivalent
(guardrails tool policies, `globalTools` gating, refine/validate) — we will not build the visual
AND/OR rules engine until there's a concrete demand. Noted as a possible later overlay field.

## 5. Primitive C — the UI agent builder + its API surface

**There is no Studio/web-ui package in this repo today.** (MEMORY.md references an
`ariaflow-studio/packages/web-ui` from an earlier era, but `find packages apps -iname "*studio*"`
and `*web-ui*` return nothing — it is not present.) The shipped UI surface is the **embed widget**
(`packages/kuralle-widget`) and the **Hono server** (`packages/kuralle-hono-server`). So the
builder is a *new* surface, and per Mastra's "the Studio UI is just a client of the REST API," we
define the API first and the UI second.

### 5a. API surface (UI is a pure client)
Add a config router to the existing Hono server, alongside the chat router. The chat router today
is `createKuralleSseChatRouter` (`packages/kuralle-hono-server/src/chatRouter.ts:29`, mounting
`POST /api/chat/sse` at `:38`) / `createKuralleChatRouter`
(`packages/kuralle-hono-server/src/index.ts:338`). New, parallel:

```
GET    /api/agents                      → [{ id, name, publishedVersionId }]   (base ids + status)
GET    /api/agents/:id                  → merged published overlay + which fields are code-locked
GET    /api/agents/:id/draft            → current draft overlay
GET    /api/agents/:id/versions         → [{ versionId, status, message, createdAt }]
PUT    /api/agents/:id/draft            → saveDraft(overlay)  → { versionId }
POST   /api/agents/:id/publish          → { versionId }       (flip pointer; no redeploy)
GET    /api/agents/:id/resources        → { tools:[], globalTools:[], flows:[], validators:[] }  (what code registered → toggle list)
```
This is a thin wrapper over `ConfigStore` + the base `indexAgents` registry. CI / agents-editing-
agents use the same endpoints (Mastra's "shared surface"). Auth/RBAC (who edits vs. who publishes)
is left to the host's existing Hono middleware — we do not build an IAM system (noted §8).

### 5b. The UI
A small React app (new package `packages/kuralle-studio`) that is **only** a client of 5a. Given the
§2 split it renders:
- Editable: name, description, **instructions** (markdown textarea), routes (`when` text + target
  picker), routing mode/default, handoffs, limits, memory/knowledge toggles, `outOfBandControl`.
- Toggle-only (from `/resources`): check tools/globalTools into the overlay, pick flows by name,
  toggle validators/refiners. **Greyed/locked** with a tooltip: model, tool executors, flow logic
  ("defined in code").
- Versioning UI: Save (draft), Publish, version list with rollback, change message.

Stack should mirror the framework's existing client (the widget uses the AI SDK transport); reuse
that for the live "test this draft" chat panel (point its transport at `/api/chat/sse` with
`overlayVersion: {status:'draft'}`).

## 6. The DEPLOY button — two distinct actions

The button is **two actions, surfaced explicitly** so the user never confuses a config change with a
host redeploy:

1. **Publish config (default, live, no redeploy).** Calls `POST /api/agents/:id/publish`. The next
   `runtime.run()` turn resolves the new published overlay at the `openRun.ts:105` seam. No process
   restart, no git commit — exactly Mastra's "applies to all callers" publish. This is the common
   path and the primary button.

2. **Deploy app (ship the host).** Only needed when the *code* base changed (new tool executor, new
   flow logic, model swap) — i.e. something the overlay cannot express. This invokes the **deploy
   path owned by the separate parallel deploy-commands plan** (this plan does not define deploy
   primitives; it only wires the button to them). The UI shows it as a secondary "Deploy host"
   action with a note: "Use this only when code changed; config edits don't need it."

The split *is* the value: §2's serializable/code boundary maps 1:1 onto Publish-config vs.
Deploy-app. If a draft references a tool/flow name not present in the deployed base, the
`PUT /draft` validation (5a) flags it and the UI routes the user to "Deploy host first."

## 7. First-iteration scope (smallest shippable)

**Goal:** edit instructions + enable/disable already-registered tools + draft/publish, run against
a live draft. Nothing else.

Concretely:
- Overlay carries: `instructions` (string), `toolRefs`/`globalToolRefs` (toggle code-registered
  tools), plus `name`/`description`. **No** routes/flows/validate editing yet, **no** new tool
  authoring, **no** visual rules engine.
- Versioning: draft + publish + version list + rollback. (A/B routing deferred.)
- Store: `MemoryConfigStore` + the Postgres table in `kuralle-postgres-store`. (Redis deferred.)
- Loader: the single merge insertion at `openRun.ts:105`, gated on `configStore` presence.
- API: `GET /api/agents`, `GET/PUT /draft`, `POST /publish`, `GET /versions`, `GET /resources`.
- UI: instructions editor + tool toggles + Save/Publish/rollback; "test draft" reuses the widget
  transport.

**Files/packages to add or touch:**
- ADD `packages/kuralle-core/src/config/AgentOverlay.ts` (Zod schema + merge fn).
- ADD `packages/kuralle-core/src/config/ConfigStore.ts` (interface + `MemoryConfigStore`).
- TOUCH `packages/kuralle-core/src/runtime/Runtime.ts:41-54` (add `configStore?` to `HarnessConfig`).
- TOUCH `packages/kuralle-core/src/runtime/openRun.ts:37-116` (merge overlay after the `:105`
  lookup; thread `overlayVersion` selector).
- TOUCH `packages/kuralle-core/src/runtime/Runtime.ts:56-67` (add `overlayVersion?` to `RunOptions`).
- ADD migration + `PostgresConfigStore` in `packages/kuralle-postgres-store`.
- ADD a config router in `packages/kuralle-hono-server` (sibling of `chatRouter.ts`), exported from
  `src/index.ts:30`.
- ADD `packages/kuralle-studio` (new React client; instructions + tool toggles + versions only).
- DOCS in `apps/docs/` + the relevant package READMEs (same change, per project rule).

## 8. Open questions / risks

1. **Referencing code resources safely (the central risk).** An overlay names tools/flows by string
   (`toolRefs`, `flowRefs`). If the deployed base no longer registers that name (code drifted), the
   merge would silently drop a tool. **Mitigation:** validate `*Refs` against the base registry on
   `PUT /draft` *and* again at the `openRun.ts:105` merge; on a missing ref at run time, fail
   closed (drop the ref + emit a warning event), never fabricate an executor. The `GET /resources`
   endpoint is the contract that keeps the UI honest.
2. **Model binding is never in config** — confirmed by §2 (`model` is a `LanguageModel` object with
   a provider key). The UI must show model as read-only. A future "pick model from a host-approved
   allow-list" would need the host to pre-register named models (deferred).
3. **`instructions` arm narrowing.** Base agents using the `AgentPrompt`/`(ctx)=>…` arms
   (`agentConfig.ts:11-14`) cannot have instructions overlaid as a plain string without losing
   logic. **Mitigation:** if the base instructions are a function/`AgentPrompt`, mark the field
   code-locked in `GET /api/agents/:id`; only string-instruction bases are editable in v1.
4. **Nested agents** (`agentConfig.ts:37`) — does an overlay apply per-leaf-agent or per-tree? v1:
   per-`id` only (each nested agent has its own overlay keyed by its id, since `indexAgents` already
   flattens children into the map at `Runtime.ts:360`). Tree-wide overlays deferred.
5. **Concurrency / publish race.** Two editors publishing different versions: last-writer-wins on
   the pointer is acceptable for v1; the immutable snapshots make it recoverable. Optimistic
   `If-Match: versionId` on publish is a cheap later hardening.
6. **Auth/RBAC** (Mastra's member-edits / admin-publishes) is **out of scope** — delegated to the
   host's Hono middleware. We document the seam, we don't build IAM.
7. **Display-conditions rules engine** intentionally not built (§4) — confirm there's real demand
   before adding a visual AND/OR evaluator; Kuralle's code-side gating already covers the safety
   cases.
