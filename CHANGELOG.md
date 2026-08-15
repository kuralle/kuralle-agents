# Changelog

## 0.23.0 — dynamic durable flows: a JSON flow dialect, resumable flow runs, and flows agents can author (BREAKING under 0.x)

Three strands land together: flows become data (a validated JSON dialect that registers onto a live runtime), flow runs become durable addresses (mint, resume, recover — across process death), and flow authoring becomes something an agent can do behind a validator instead of a human behind a compiler. Breaking changes ship under **0.x rules**, where a minor may break.

### Breaking

- **`defineFlow` validates at definition time and throws.** Duplicate node ids, a `start` outside `nodes`, unresolvable `goto` targets, and nodes unreachable from `start` are now definition errors, not runtime surprises. Transition targets must be **registered** nodes — the same object present in `flow.nodes`, or `{ goto: '<id>' }`. Inline node objects and transition thunks are rejected (`inline-transition-target`) — statically where transitions are declared, and at run time for transitions returned from handlers. Code flows project through the same structure validator the JSON dialect uses, so the two dialects cannot drift on what a legal graph is.

### The JSON dialect

`FlowDefinition` is the flow graph as data: `reply` (exactly one of `response: { template }` — engine-rendered, never model-authored — or `generate: true`), `collect`, `action`, `decide`; transitions by node id (`TransitionRef`); a typed predicate DSL over `input | state | results.<nodeId> | requestContext` for `routes[].when`; `MappingConfig` (`{ value } | { path } | { template }`) with `${...}` templates for `action.args`. `validateFlowDefinition` returns issues that carry machine-followable **repair actions** (`operation`, `arguments`, `legalSources` with schema compatibility) — built for an authoring agent that fixes its own output, not just a human reading messages.

`gates` on a definition (or a code `Flow`) run at terminal transitions: predicate gates, or judge gates over an **explicit allow-list** of run-record paths. `blocking` fails the run with outcome `failed-verification`; `advisory` records a verdict; a gate that fails to *execute* always blocks, even declared advisory — a check that did not run is not a check that passed.

### Durable flow runs

`runtime.run({ kind: 'flow', flowName })` mints a headless, addressable flow run; `TurnHandle.runId` resolves at run open — before the turn body finishes — so the id you must resume with survives a turn that later throws. Resume is `runtime.run({ sessionId, runId })`, fail-closed on unknown and cross-session ids. `recoverOrphanedRuns` re-enters running runs whose execution lease went stale (crashed replica) through that same resume path; `sweepDeadlines` delivers the timeout outcome to paused runs past `waitingFor.deadline`; `findUnresumableRuns` lists what a version refuses to resume so it can be drained before an upgrade. Shared journals: `PostgresRunStore` (`@kuralle-agents/postgres-store`) and `SqlRunStore` (`@kuralle-agents/cf-agent`, DO SQLite); per-session `SessionRunStore` stays the default.

**A parked run pins its flow's digest.** Redefining a flow under a parked run makes resume throw `FlowDriftError` — named run, node, expected and actual digest, recovery `restart | abandon` — never a silent resume against a graph the run never saw.

### Registration and supply

`runtime.addDynamicFlows(defs, { agentId, replace? })` registers a bundle atomically onto the agent's live catalog — every definition validates against the agent's actual tool surface first; failure rolls the catalog back and compensates persisted rows. `loadDynamicFlows` reloads `active` versions at boot, skipping invalid rows with a warning so one corrupt definition cannot sink the process. Versions persist in a `FlowDefinitionsStore` (Memory, Postgres, Redis, DO SQLite). Over HTTP, `GET/POST/DELETE /api/stored/flows` (hono-server and cf-agent) reuses `Policy` as the gate — decisions requested as `stored-flows:read` / `stored-flows:write`; `ask` is deny on this surface. Flows also arrive as files: top-level `flows/*.flow.json` in file-authored agent folders (`kuralle build` embeds them) and `flows/` directories in Agent Plugins.

### Authoring

`createFlowBuilderAgent` composes `FLOW_BUILDER_AUTHORING_PLAYBOOK` ahead of your surface policy and wires save/list/validate tools against a `FlowBuilderHost`. Authoring definitions may write `when: { nl: "..." }`; NL predicates compile to the DSL **at save time**, with provenance pinned on the stored version (compiler model id, prompt hash, compiler version) — what runs is always the compiled predicate, never the prose.

### Collect, hardened

`collect.resolvers` resolve slots deterministically before the model sees them (tier-0): `enum_check`, `range`, `jsonpath`. A resolved field is excluded from the model schema that turn; an ambiguous match falls back to the model rather than guessing.

`collect.verbatimFields` names the slots the user must supply in their own words — an account id, an order number, a name. A model-extracted value for one of those is dropped, not merged, when the source turn does not contain it. Guard only what is quoted rather than normalised: extraction legitimately rewrites what the user said (`next Friday` → an ISO date, `forty dollars` → `40`, a spoken complaint → a written summary), and a value chosen from a list or button reply is never in the turn text at all. Applying the check to every field drops correct data, and a dropped *required* field keeps the node asking until it exhausts `maxTurns`.

A collect node whose `maxTurns` runs out completes **only if its schema is genuinely satisfied**; otherwise it escalates and names the fields it could not collect. Running out of turns is not the same as finishing, and handing a downstream `action` a half-filled record is how an intake SOP creates a record against whatever happened to be in state.

### Known limitation — JSON-dialect schemas are not validated at run time

A `FlowDefinition` collect `schema` is used to shape the model's extraction tool and to derive `required`, but it is **not enforced against submitted values**: `adaptJsonSchema` returns a passthrough whose `validate` returns the value unchanged (`validated: false`), pending a workerd-safe JSON Schema validator. A slot declared `{ type: 'number' }` will therefore accept a string, and the "purge collected values the schema rejects" pass in the collect loop is inert for JSON flows. Code flows built with `defineFlow` and a real Standard Schema (zod) validate normally. Declare `required` accurately and treat JSON-dialect collect output as untrusted at the boundary where it matters.

## 0.22.0 — Agent Plugins v1.0.0 conformance, launch containment, and DO wake without rediscovery

Agent Plugins v1.0.0 conformance for the plugin loader and MCP client, plus the gaps a live run found rather than a type-check.

**Conformance.** `PLUGIN_DATA` is created and proven writable before a subprocess starts (§9.1). A stdio server launches the way §7.2.1 describes: plugin-relative command resolved against the plugin root, `cwd` defaulting to that root, and a composed rather than inherited environment. Containment is resolved **through symlinks** at both the paths the loader reads and the paths a plugin declares, so a `bin/server` symlinked outside the plugin root is refused where a lexical check cannot see it (§4.1(3), §4.1(4)). Proven on workerd, including Durable Object SQLite.

**Correctness.** Two plugins may each name a server `local` — a name is only unique inside one `mcp.json`, and Agent Plugins has no global registry. One used to vanish with no diagnostic. Both now project under names suffixed with a hash of the server's identity, so the result does not depend on plugin load order and a `Policy` rule cannot silently repoint at a different backend.

**Performance.** A Durable Object wake serves its tool map from the persisted catalogue with no `tools/list` round trip, reconciles against the server in the background, and refuses a withdrawn tool with a message the model can act on. An existing DO migrates automatically.

**Compatibility.** `z.email()` compiles to a lookaround regex that models validating tool schemas strictly now reject; the affected example uses an equivalent pattern without one.

`McpToolset` gains `reconciled`. `McpServerConfig` (stdio) gains `cwdRoot` and `PersistedServer` gains `tools`, both optional. No breaking public API.

## 0.21.1 — deferred MCP tools keep their argument contract

A deferred MCP tool now keeps its argument contract — parameter names, scalar types and `required` — and defers only descriptions and constraints. The bare `{ type: 'object' }` schema it replaced left the model with nothing to call against, producing a malformed call in 2 of 5 live runs against 0 of 5 inline. The Loom & Field example went to 5 of 5.

## 0.21.0 — memory isolation, an explicit memory search, and zero duplicate exported names (BREAKING under 0.x)

This release also carried the first publishes of `@kuralle-agents/plugins` and `@kuralle-agents/mcp` (Agent Plugins v1.0.0 support and the MCP client). Both, and `@kuralle-agents/pi-driver`, were added to the changesets `fixed` group: each declares `core` as a `workspace:*` dependency, which pnpm rewrites to an exact version at publish, so outside the group they would have drifted off the shared version line and handed consumers two copies of `core`.


Three strands: closing a cross-user leak in the memory stores, giving memory a read path the agent can actually call, and resolving every duplicate exported name in `core`. Breaking changes ship under **0.x rules**, where a minor may break.

The recurring finding across all three is worth stating up front, because it shaped what got built: **a surprising amount of the public surface was exported, documented, and connected to nothing.** The V1 `MemoryService`, `HarnessConfig.memoryService`, `StopConditions`, `TracingService`, `AgentRoute` — five separate cases, each looking live from the outside. Three of the duplicate names turned out to be pointing at one of them rather than at a naming problem.

### Breaking

- **A session with no `userId` gets no user-scoped memory.** It previously fell back to a shared `'anonymous'` owner, which pooled every userless session's memory together — one visitor's `USER` block loaded into the next visitor's prompt. Reachable on `chatRouter` and the OpenAI-compat endpoint, neither of which requires a `userId`. It now fails closed with a warning.
- **`userId` must match `^[A-Za-z0-9._@+:~|-]+$`.** That accepts what real identity providers issue — `maya@example.com`, `google-oauth2|123`, `tenant:acme` — and rejects path and glob characters. An id outside it is refused rather than sanitised, because sanitising two ids into one string is how two users end up sharing a row.
- **`memory_block` can only address blocks the agent declares.** `block` is now a `z.enum` over `workingMemory.autoLoad`, and the free-text `scope` input is gone. Ad-hoc blocks were never readable in a later session anyway — the model could create one and never find it again.
- **`memory.ingest` is removed**; fact memory is an extractor: `extract: [factsExtractor()]`. `HarnessConfig.memoryService` is removed — it was declared and read nowhere, so it silently dropped whatever you passed.
- **The V1 `MemoryService` is removed** with its four implementations, plus `MemoryEntry`, `MemoryIngestionOptions` and `extractMemories`. Nothing in the runtime ever called it; `runRefinementPolicies` passed `memoryService: undefined` unconditionally.
- **`Tool` now means Kuralle's tool.** It did not. The root index exported the AI SDK's type explicitly while the framework's own effect-tool contract arrived through `export type *`, so the explicit one won — `import { Tool }` handed you the AI SDK's, and Kuralle's shipped as `EffectTool`. The AI SDK alias is now `AiSdkTool`, `Tool` is the effect contract, and `EffectTool` is removed.
- **`StopConditions` and `EnforcementRules` are removed.** `maxSteps()`, `tokenBudget()`, `timeout()` and the rest had zero call sites and there was no config field to register one — `HarnessConfig.stopConditions`, which `GUARDRAILS.md` documented as "enabled by default", never existed. Use `limits` on the agent, which is what always ran.
- **Also removed, each with no caller:** `AgentRoute`, `TracingService`, `InMemoryMetricsService`, `MetricsService`, the legacy `RunContext` export, `foundation`'s `ToolExecutor`/`ExecutableTool`, and the telemetry types (`TracingConfig`, `Span`, `SpanEvent`, `MetricsConfig`, `ObservabilityMetrics`, `Metrics`, `TraceStreamEvent`, `SessionTelemetry`, `SessionEndMetadata`). Live tracing — `HarnessConfig.tracing`, `TraceStore`, `AgentSpan` — is untouched.

### Two users could share a memory row

Three of the five `PersistentMemoryStore` backends mapped distinct owners onto one storage key. `InMemory` and `Redis` composed `${scope}:${owner}:${key}` unescaped, so `(owner: 'a:b', key: 'K')` and `(owner: 'a', key: 'b:K')` were the same row. `File`'s `safe()` collapsed `/`, `\` and `..` to a single `_`, so `alice/bob` and `alice_bob` were one file — a path-traversal guard being used as a key derivation. `listBlocks` was worse than a collision: owner `a` could enumerate owner `a:b`'s **block names**.

The fix is three layers, and the shape came from reading what LangGraph and `deepagents` actually do rather than from first principles:

1. **Validate and reject at the boundary.** An encoder makes every malformed owner legal — the `?? 'anonymous'` bug above would have acquired a tidy valid row under one, and failed loudly under a validator.
2. **Stop flattening where the medium does not force it.** Postgres and DO SQLite were never affected because they keep a real `PRIMARY KEY (scope, owner, key)`. `InMemory` is now a nested `Map` for the same reason.
3. **Encode only where a single string is unavoidable, per medium.** Redis escapes `:` alone; the filesystem additionally escapes `|` and `:`. An earlier revision escaped `@` too and would have silently orphaned every email-shaped owner's memory on upgrade — escaping more than the medium requires is not free.

Windows device names (`NUL`, `COM1`) now escape, and `listBlocks` no longer throws `URIError` on a hand-seeded file containing a bare `%`. **Known limitation:** case-insensitive filesystems still fold `Alice` and `alice`; closing that costs the human-editable filenames the store deliberately offers, so it is documented on `encodeFileSegment` and filed rather than decided.

### Memory you can ask

`defineExtractor` shipped as public API and was **write-only**. `preloadMemoryContext` loads exactly one hardcoded slug, so any custom extractor was persisted every turn and read by nothing — the `memory-concierge` example shipped a `dietaryProfile` extractor whose value nothing could reach.

`search_memory` is the model-callable read path over the same store, which is the split every comparable framework converged on — Letta's `archival_memory_search`, langmem's and Zep's `create_search_memory_tool`. Automatic recall stays facts-only; the tool reaches every declared extractor. `slug` is a `z.enum` over your `extract` list, so an undeclared slug is not rejected at runtime — it cannot be expressed, which is what lets `ExtractedValueStore` keep having no `list()`.

`lexicalScore` is now shared by both paths so they rank identically. **It is not a pure extraction:** it gained a 6-character shared-prefix fallback so `allergic` reaches a field named `allergies`, which substring matching never bridges. Because `preloadMemoryContext` uses `score > 0` as a membership filter, that widens what automatic recall injects — nothing that was injected before stops being, but existing agents will see a different, generally more relevant selection.

### Packaging

Five packages declared `core` as both a `dependency` and a `peerDependency` — one says "I install my own copy", the other "the host supplies it so we share one". Resolved per package: `cli` keeps a plain dependency because it ships a `bin` and nobody hosts an executable; the four libraries move to peer + dev. Verified against real tarballs with `workspace:*` rewritten the way `pnpm publish` does: one copy of core, clean `tsc`, and forcing a second copy reproduces `Types have separate declarations of a private property 'config'.`

### Added

- **`ExtractedValueStore` backends** for Postgres, Redis and Durable Object SQLite, behind a shared conformance suite.
- **An extraction trigger policy.** Extraction defaults to `{ tokens: 2000 }` of un-extracted history and is non-blocking, so an ordinary turn costs nothing.
- **`kuralle send --user`** — the CLI never passed a `userId`, so user-scoped memory was entirely inert from it.
- **Guards that cannot rot:** no workspace package may declare an internal package as both a dependency and a peer; and `KNOWN_DUPLICATES` is now `{}`, with the duplicate-export check scoped per package and catching cross-package re-exports.

### Fixed elsewhere

Both store READMEs and the usage skill's memory reference told consumers to import classes this release deletes — and to pass `memoryService`, `preloadMemory` and `memoryIngestion` to `createRuntime`, which `HarnessConfig` has never accepted. All three are rewritten against the real surface, as is `GUARDRAILS.md`.

## 0.20.0 — skills second pass, bounded tool execution, and three streaming-turn fixes (BREAKING under 0.x)

Three strands land together: a second pass on the skill system, hardening of how tools actually execute, and three ways a streamed turn could fail a user without failing loudly. The whole package family moves 0.19.x → 0.20.0 in lockstep.

Breaking changes ship here under **0.x rules**, where a minor may break.

Most of what follows was found by building a full worked example — a port of Vercel's marketing-team template — and running it live rather than typechecking it. Every fix below has a test that was verified to fail when the fix is removed.

### Breaking

- **`parallelSafe` is now `boolean | ((args) => boolean)`.** A static boolean forced a tool with a read mode and a write mode to pick one classification for both. The predicate runs on the raw model arguments *before* schema validation, so it must be total: any throw or non-boolean return fails closed to serial. The model cannot influence the decision either way.
- **`replay: false` no longer implies parallel-safe.** They are unrelated properties — one means "do not journal this step", the other means "safe to run concurrently with siblings". Tools that relied on the implication must declare `parallelSafe` explicitly.
- **Filesystem skill discovery defaults to `/.agents/skills`**, not `/skills`. Pass an explicit root to `fsSkillStore` to keep the old location. A store whose configured roots are *all* unreadable now warns once on console — it can never return a skill, and silently discovering nothing is how this move broke callers that relied on the default.

### Security

**Caller-supplied `formData` could overwrite framework run state.** A request carrying `formData: { resolvedSkills: … }` replaced the per-tenant skill snapshot wholesale: the resolver never ran, the tenant's real skills vanished from the prompt, and attacker-chosen skill names and bodies reached the model in their place. Framework state now lives under one reserved key, and that key is stripped from incoming form data — two overlapping defences, so an internal added later is protected by construction rather than by someone remembering to extend a denylist.

### Three ways a streamed turn failed quietly

**A failing turn killed the process.** A `TurnHandle` is both a promise and an event source, and a failing turn delivers its error down both. Consumers that only stream — `toUIMessageStreamResponse()`, `toResponseStream()`, or iterating `handle.events` — never touch the promise half, so the second delivery landed with no handler attached and took the whole process down on `unhandledRejection`. One bad provider call killed a server for every other session on it. The rejection is now marked handled at the source without being swallowed: `await runtime.run(...)` still throws for anyone who awaits it. `hono-server`'s raw-SSE router had defended itself; the UIMessageStream path had not, which is the asymmetry a per-call-site fix keeps producing.

**Turns could end in silence.** `maxSteps` defaults to 5, and an agent that grounds itself, loads two skills, writes something and lints it exhausts that before it ever summarises. The loop fell out with no further model call — ten tool calls, a `finish`, and not one character for the user. Hitting the ceiling now triggers one wrap-up call with **no tools offered**; offering them would invite another call and reproduce the silence a step later. Typed extraction is unaffected — it is deliberately mute and exits through its own stop condition.

**Proxies buffered the whole turn into one frame.** `toUIMessageStreamResponse` now sets `Cache-Control: no-cache, no-transform`, `Content-Encoding: identity` and `X-Accel-Buffering: no`. A Next.js rewrite in front of the server collected every chunk whenever compression was negotiated — which a browser always does — so the UI showed a spinner for 37 seconds and then everything at once. Measured on the page: 18 DOM mutations for that turn, 17 of them inside the final 700ms. Worth knowing how this hides: a plain `curl` sends no `Accept-Encoding`, so it measures a healthy stream while the browser sees nothing. Use `curl --compressed`, or measure in the browser.

### Bounded tool execution

- **Concurrency defaults to 8** instead of "whatever the model emitted". `Limits.maxToolConcurrency` was optional and documented as unbounded, and nothing ever set it, so the model's batch size *was* the policy. Eight is measured: against the durable run store, 20 unbounded parallel calls executed only 8 — the other 12 threw `Stale write for session …` out of `appendPendingStep` without ever reaching their executor.
- **Tool results are capped where they enter the transcript.** Any user-defined tool could land an unbounded payload in `run.messages` and re-send it on every subsequent model call. The cap lives at the transcript boundary and nowhere else, so `ctx.tool()` and the durable journal keep the full value — only what the model reads is bounded. Truncation is middle-out, because the end of a payload holds the error, the total and the last record.
- **Parallel results append in source order**, not completion order, and a batch announces itself with an ordered `tool-batch-start` before any dispatch — so a UI can allocate a stable block before work starts, and a replayed run rebuilds the same layout.
- **An abnormal finish is distinguishable from a clean stop.** `length`, `content-filter`, `error` and `other` all took the same branch as `stop`, so a response truncated at the output-token limit ended the turn as a success: the user got half a sentence and no caller could tell. A new `turn-incomplete` internal stream part reports the reason, and only a step-budget exit triggers the wrap-up — retrying after an output-limit truncation just reproduces it.

### Skills, second pass

`SKILL.md` front matter parses through a real YAML parser under the failsafe schema, so `version: 1.0` stays the string it was written as instead of becoming `1`, and a malformed skill fails loudly with the file named rather than being silently skipped. `load_skill` returns a framed briefing that lists each bundled resource beside the exact `read_skill_resource` call that fetches it, so a model no longer has to guess that resources exist or how to reach them.

`allowed-tools` is enforced at the tool boundary through `Policy` rather than by asking the model to remember it — though only once `load_skill` has succeeded for that skill, which makes it a guard-rail for an honest model, not an adversarial boundary. Only skills that actually declare a list contribute to the permitted set, so adding an unrestricted skill never silently narrows what another one allowed.

Skills can be packaged into the build with `packageSkillsDirectory` from `@kuralle-agents/build`. Packaged skills are workerd-clean — no `node:` builtins, no filesystem — so one skill set runs on Workers and Node without a second code path. Packaging refuses to bundle secrets, and skill ids are content-addressed over length-prefixed `(path, content)` pairs so two skills cannot collide on name alone.

The prompt catalog is frozen at a per-run baseline with changes announced in-transcript instead of by rewriting the system prompt, so a skill appearing mid-conversation no longer invalidates the cache for every turn that follows; the baseline is rebuilt only at compaction. `ctx.getSkill(name)` gives a read-only handle for reading a skill's own bundled files, and a per-tenant `SkillResolver` lets one deployment serve different skill sets to different tenants.

### Added

- **`defineExtractor` and `AgentMemory.extract`** — the declaration surface for cross-session memory beyond the single hard-coded facts extractor. A Zod schema is required (tag-scraping is only cheap if you already run an observer agent, which Kuralle does not), and the slug is derived from the name rather than declared, so a rename cannot orphan previously persisted values. Declaration only: no runner, no persistence, no model calls yet.
- **`Limits` and `Guardrails` are exported.** `AgentConfig.limits` was public API whose type was reachable from nowhere, so an app could set `maxSteps` but not name the type it was passing.
- **`apps/examples/marketing-team`** — lead plus five specialists, 20 skill packages, Postgres via Drizzle, a Next.js frontend with a Tiptap editor and AI Elements chat. Live-verified end to end.

### Fixed elsewhere

`bun run typecheck:all` — the release gate — was red before this release, and three of the five failures it now fixes were already on `main`. `bun test` does not typecheck, so none of them were visible to any suite.

## 0.14.0 — one trace surface, one stream envelope, skills in core (BREAKING under 0.x)

Combines the stream-envelope break, removal of lifecycle APIs that were publicly exported but never wired to the runtime, the skills consolidation, and the tool-execution fixes. The whole package family moves 0.13.x → 0.14.0 in lockstep.

Breaking changes ship here under **0.x rules**, where a minor may break. The API is still settling; this is deliberately not a 1.0 stability commitment. Note Changesets escalates a 0.x minor to 1.0.0 whenever a package carries `workspace:*` peers, so this family is versioned manually.

### Removed the misnamed `@kuralle-agents/core/hooks` subpath

The `./hooks` subpath's barrel exported `TracingService`, `MetricsService`, and `InMemoryMetricsService` — three services re-exported from `../services/`. **No hooks.** The live `Hooks` interface lives at `types/hooks.ts` and reaches users through the package root. The subpath was collateral from removing `HarnessHooks`: the directory's real contents (`HookRunner`, `helpers.ts`, the built-in logging/metrics/observability hooks) were deleted and the barrel was reduced to the two service re-exports that happened to live there. Nobody decided the name.

Measured before removal: **zero consumers** of `@kuralle-agents/core/hooks` across `packages/`, `apps/`, `examples-deploy/`, `docs/`, and `apps/docs/`, and zero consumers of the three services through that subpath (the only internal use imports the service files directly). The `Hooks` type already has a canonical home at the package root.

- **Removed:** the `./hooks` export-map entry and the `src/hooks/` directory.
- **The three services remain public** — now exported from the package root, alongside the rest of the observability surface (`MemoryTraceStore`, `OtelTraceSink`, `TraceRecorder`):
  - Before: `import { TracingService } from '@kuralle-agents/core/hooks'`
  - After: `import { TracingService } from '@kuralle-agents/core'`
  - Before: `import { MetricsService, InMemoryMetricsService } from '@kuralle-agents/core/hooks'`
  - After: `import { MetricsService, InMemoryMetricsService } from '@kuralle-agents/core'`
- **`Hooks` is unchanged** — `import type { Hooks } from '@kuralle-agents/core'` already worked and still does; nothing was ever importable as `Hooks` from `./hooks`.
- Added `packages/core/test/exports-map.test.ts`, which dynamically imports every subpath declared in the `exports` map against the built `dist` and fails if any cannot resolve — so an export-map entry can never again silently point at the wrong (or a missing) file. It also asserts `./hooks` is not re-added.

### Removed lifecycle surface

- Removed `HarnessHooks`; `HookRunner` and `createHookRunner`; `loggingHooks` and `createLoggingHooks`; `createMetricsHooks` and `InMemoryMetrics`; and `createObservabilityHooks` and `ObservabilityConfig`.
- Removed the hook-helper exports `initTracing`, `startSpan`, `endSpan`, `addSpanEvent`, `getCurrentSpan`, `createTracingHooks`, `initMetrics`, `getMetrics`, `createObservabilityMetrics`, `createTelemetryHooks`, and `captureSessionTelemetry`. The independent `TracingService`, `MetricsService`, and `InMemoryMetricsService` services remain.
- Removed `foundation/ConversationEventLog.ts` (`ConversationEventLog` and `ConversationEvent`), `foundation/ConversationState.ts` (`ConversationState`), `foundation/createFoundation.ts` (`createFoundation`, `Foundation`, and `FoundationConfig`), `foundation/DefaultConversationEventLog.ts` (`DefaultConversationEventLog` and `DefaultConversationEventLogConfig`), and `foundation/DefaultConversationState.ts` (`DefaultConversationState` and `DefaultConversationStateConfig`). `AgentDefinition`, `AgentStateController`, `DefaultAgentStateController`, and `ToolExecutor` remain. **`DefaultToolExecutor`, `DefaultToolExecutorConfig` and `ToolTimeoutError` (the `foundation/` copy) are also removed** — `createFoundation` was their only caller, leaving them orphaned. The public `ToolTimeoutError` is unaffected: it resolves from `tools/effect`.
- Removed the orphaned `TurnEndHookResult`, `StepResult`, `TurnSummary`, `BeforeModelCallData`, and `BeforeModelCallResult` types.

These APIs could never provide the lifecycle telemetry they promised. A live runtime probe reached only 5 of the 21 `HarnessHooks` method names; 16 were inert. Static tracing found `HookRunner` constructed only by `createFoundation`, which had zero callers, and the live `Runtime` never constructed or referenced it. Keeping the types would preserve silent failure rather than working compatibility.

### Migration: `HarnessHooks` to `TraceSink`

| Removed hook | Trace replacement |
|---|---|
| `onStart`, `onEnd`, `onTurnEnd` | Completed `turn` span |
| `onToolCall`, `onToolResult`, `onToolError` | `tool` span with input, output, status, and error attributes |
| `onAgentStart`, `onAgentEnd` | `agentId` on spans |
| `onHandoff` | `handoff` span with `handoffFrom` and `handoffTo` |
| `onStepStart`, `onStepEnd` | `flow` and `node` spans |
| `onTokensUpdate` | `tokensIn`, `tokensOut`, and `contextTokens` on the turn span |

Before:

```ts
import { createRuntime, type HarnessHooks } from '@kuralle-agents/core';

const hooks: HarnessHooks = {
  async onToolResult(context, call) {
    await analytics.track({
      sessionId: context.session.id,
      agentId: context.agentId,
      workspaceId: 'my-workspace',
      type: 'tool.completed',
      data: { toolName: call.toolName, durationMs: call.durationMs },
    });
  },
};

const runtime = createRuntime({ agents, defaultAgentId: 'support', hooks });
```

After (the same sink used by `docs/skills/kuralle-usage/references/analytics.md`):

```ts
import {
  createRuntime,
  OtelTraceSink,
  type AgentSpan,
  type TraceSink,
} from '@kuralle-agents/core';
import {
  createAnalyticsClient,
  type AnalyticsClient,
  type AnalyticsEventType,
} from '@kuralle-agents/analytics-sdk';

const analytics = createAnalyticsClient({
  apiKey: process.env.ANALYTICS_API_KEY!,
  workspaceId: 'my-workspace',
});

class AnalyticsTraceSink implements TraceSink {
  constructor(
    private readonly client: AnalyticsClient,
    private readonly workspaceId: string,
) {}

  async write(span: AgentSpan): Promise<void> {
    const { sessionId, agentId = 'unknown' } = span.attributes;
    await this.client.track({
      sessionId,
      conversationId: sessionId,
      agentId,
      workspaceId: this.workspaceId,
      type: analyticsEventType(span),
      data: {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        kind: span.kind,
        name: span.name,
        status: span.status,
        startTime: new Date(span.startTime).toISOString(),
        endTime: span.endTime ? new Date(span.endTime).toISOString() : undefined,
        durationMs: span.endTime ? span.endTime - span.startTime : undefined,
        attributes: span.attributes,
      },
    });
  }

  flush(): Promise<void> {
    return this.client.flush();
  }
}

function analyticsEventType(span: AgentSpan): AnalyticsEventType {
  if (span.kind === 'turn') return 'conversation.ended';
  if (span.kind === 'tool') return span.status === 'error' ? 'tool.error' : 'tool.completed';
  if (span.kind === 'handoff') return 'handoff.initiated';
  if (span.kind === 'node') return 'node.exited';
  return 'custom';
}

const runtime = createRuntime({
  agents,
  defaultAgentId: 'support',
  tracing: {
    sinks: [
      new AnalyticsTraceSink(analytics, 'my-workspace'),
      new OtelTraceSink({
        endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT!,
        serviceName: 'support-agent',
      }),
    ],
  },
});
```

Turn spans now include `agentId`, which makes trace export a true superset of the removed per-agent hooks. The turn keeps the initiating agent for stable run-root attribution; a handoff opens a separate transition span, and subsequent child spans carry the target agent. `toOtlpPayload` exports the value as `kuralle.agentId`, so `OtelTraceSink` and `langfuseSink` retain it.

### Stream envelope and explicit audience

- Renamed `HarnessStreamPart` to `StreamPart` and replaced flat variant fields with the `{ channel, type, payload }` envelope.
- Removed the shadow stream union formerly exported from `types/voice.ts`; knowledge types now live in `types/knowledge.ts`, and all six emitted knowledge events narrow from the public `StreamPart` export.
- Added the exhaustive `PART_CHANNEL` map. `@kuralle-agents/hono-server` uses it as the single owner of client-vs-internal filtering.

Stream migration: rename imports to `StreamPart`, read variant fields through `part.payload`, and include both `channel` and `payload` when constructing test or custom stream parts.

### WebSocket frames now satisfy the stream contract

The envelope reshape swept every *typed* emit site, but `@kuralle-agents/hono-server` hand-built its WebSocket frames as `JSON.stringify` object literals — which `tsc` cannot check against anything. They kept the pre-envelope flat shape and included `suggested-questions`, one of the deleted variants.

- Every WebSocket send is now a typed `StreamPart` routed through the same `PART_CHANNEL` filter as the SSE path, so the client/internal split holds on both transports. `createKuralleRouter`'s socket previously applied no filter at all and could deliver internal parts, and unredacted `error` payloads, straight to a browser.
- Added `WebSocketTransportFrame` for genuine transport messages (`connected`, `cancelled`, `pong`). These are not stream parts and are no longer pretending to be.
- **Removed the suggested-questions feature**: the `widgetWelcomeSuggestions` router option, and the corresponding rendering in `@kuralle-agents/widget`. This is a capability removal, not only a type cleanup — the server emitted it and the widget rendered it. If you use `widgetWelcomeSuggestions`, there is no drop-in replacement; send the prompts as ordinary assistant text, or pin the previous version while we decide whether to restore it as a first-class client part.
- `@kuralle-agents/widget` also dropped its handlers for `step-start`, `step-end`, `agent-start`, `agent-end`, `interrupted`, and `cancelled` — all deleted from the union — and for `handoff`, which remains `internal` and so never reaches a browser under the default `safe` filter.

### Lifecycle hooks can no longer break a run

The five live `Hooks` callbacks were invoked without isolation: `onStart`, `onError`, `onEnd`, and `onConversationEnd` were bare `await`s, so a throwing hook aborted the run, and `onStreamPart` was a bare `void` call, so a rejection surfaced as an unhandled rejection.

Hooks are user code and now follow the same rule as `TraceSink`: **observation never participates in run correctness.** A hook that throws or rejects is contained and reported via `console.error`, and the run proceeds. Unlike trace sinks, hook failures are logged rather than silent — silent failure is how the removed `HarnessHooks` defect stayed invisible.

This is a behaviour change: a hook that previously failed a run will now let it succeed. If you relied on a throwing hook to abort a turn, move that logic into a guardrail or a flow node — the hook surface is for observation only.

### Removed the second tool-error surface

- Removed `packages/core/src/tools/errorHandling.ts` and its exports from `@kuralle-agents/core/tools`: `withErrorHandling`, `executeWithRetry`, `createCircuitBreaker`, `withTimeout`, `isPermanentError`, `isCircuitOpenError`, `CircuitOpenError`, and a **second** `ToolTimeoutError`.

That second `ToolTimeoutError` was the reason. Two distinct classes shared the name, each reachable from a different public entry point of the same package — `@kuralle-agents/core` resolved to `tools/effect/errors.ts`, `@kuralle-agents/core/tools` to `errorHandling.ts`. Both set `name = 'ToolTimeoutError'`, so a `catch (e) { if (e instanceof ToolTimeoutError) … }` written against the natural import silently failed to match a timeout thrown by `withTimeout()`, with no diagnostic signal in logs or stack traces.

The module had no internal consumers — every export resolved only to its own barrel line. The functions worked; they were simply a second, unwired timeout mechanism (plus an unwired circuit breaker) sitting beside the live one in `tools/effect/ToolExecutor.ts`. `ToolTimeoutError` imported from `@kuralle-agents/core` is unchanged. If you used `withTimeout` or `createCircuitBreaker`, copy them into your project — they had no dependency on Kuralle internals.

Added `exported-definition-uniqueness`, a type-checker-backed guard asserting each publicly exported name has exactly one definition. It found 18 further duplicates, tracked on an explicit allow-list so new ones fail immediately.

### Tool execution: control-flow signals, cancellation, concurrency

Found by comparing our tool execution against OpenAI Agents JS, LangGraph, Mastra, DeepAgents, and the AI SDK.

**A model-issued `needsApproval` tool never paused the run.** `ctx.tool` throws `SuspendError` to suspend; `executeModelToolCall` caught *every* error into a tool-error result. Reproduced against a real executor and run store: the store recorded `status: 'paused'`, `waitingFor: '__approval'` — while the turn kept going and handed the model the literal string `Run suspended waiting for __approval` as a tool failure, plus a client-facing `error` part for what is a routine approval gate. The tool body never ran, so nothing unauthorized executed; the control flow was wrong, not the gate.

Flow `action` nodes were never affected — `runFlow` already rethrew both `SuspendError` and `ToolApprovalDeniedError`. The model path simply never learned that rule. Both now share one `isControlFlowSignal` predicate so they cannot disagree again.

The fix keeps the property the parallel path depends on. `executeModelToolCall` still never rejects: a signal comes back as a *value* on the outcome, and the dispatcher rethrows it only once the whole batch has settled. Failing fast would abandon in-flight siblings — you cannot cancel a running promise, so the effect would happen anyway with its journal step left `running` and re-executed on resume.

**A denied approval crashed the turn.** `ToolApprovalDeniedError` was thrown by `ctx.tool` and caught by nobody: it is not in `isDegradableRuntimeError`, so `Runtime.run` rethrew it and the rejection escaped the runtime entirely. A supervisor clicking "deny" ended the turn with an exception — the model was told nothing, the user was told nothing.

A denial is now a **result** on the model path: `{ __denied: true, toolName, deniedBy, message }`, so the agent can tell the user the request was declined. No client `error` part, because nothing malfunctioned, and `__denied` rather than `error: true` keeps it distinguishable from a genuine failure.

Flow `action` nodes are unchanged — `ctx.tool` still throws there, because the node's author chose to call the tool and can catch it or branch on `ctx.approve()` instead. Both paths still refuse to be degraded into "something went wrong on my side"; that message is for malfunctions, and a human saying no is not one.

This corrects a classification made earlier in this same release. `isControlFlowSignal` originally covered both `SuspendError` and `ToolApprovalDeniedError`, mirroring a grouping in `runFlow`. But `runFlow` grouped them to keep both out of the degrade path — not because both defer the run. A suspend defers a decision; a denial resolves one. They are now separate predicates, `isControlFlowSignal` and `isApprovalDenial`, with the shared reason stated at the one place that needs both.

**`timeoutMs` abandoned the tool instead of cancelling it.** The old implementation raced a `setTimeout` against the tool's promise; on timeout the runtime stopped waiting and the tool kept running to completion. The timeout is now composed into the `AbortSignal` handed to the tool, so a cooperative tool actually stops. The race remains, to bound tools that ignore the signal — neither mechanism suffices alone. `interruptible: false` still opts out of caller-driven barge-in, and still does not opt out of `timeoutMs`.

**Added `limits.maxToolConcurrency`.** A parallel batch ran unbounded, letting the model decide how many sockets, subprocesses, or rate-limited calls opened at once. Omitted, behaviour is unchanged.

**Added `onError` to `defineTool`.** Return a result the model can act on instead of a generic failure; it is validated against `output` and journaled as the success it became. Deliberately not called for a timeout, an abort, a schema violation, or an approval decision — those are facts about the run, not results a tool may reinterpret.

**Async-generator tools now stream.** Each `yield` is emitted immediately as an internal `tool-result` part with `preliminary: true`. Only the aggregate is journaled, so a replayed call emits nothing and replay stays deterministic.

### Parallel `ctx.tool` from action nodes

`await Promise.all([ctx.tool(…), ctx.tool(…)])` — the obvious way to parallelise — previously threw `LogConflictError`, naming a journal invariant rather than anything actionable. Concurrent calls each read the step count before any of them appended, so they all claimed the same ordinal.

`ctx.tool` now reserves its journal ordinal when the call starts, using the run store's atomic `reserveSteps` where available and serializing pending appends where it is not. `reserveSteps` remains optional on `RunStore`, so custom stores need no change. `LogConflictError`'s message now names `ctx.reserveCallsites(count)` for callers supplying explicit indices.

## 0.10.0 — Retrieval hardening: embedder lock, incremental ingest, persistent keyword tier, multilingual keyword search

Unified bump across the graph (0.9.0 → 0.10.0). Contains **breaking** `@kuralle-agents/rag` option renames (minor bump per repo convention). Grounded in a measured before/after benchmark plus live Cloudflare + Fly deployment verification (`packages/rag/bench/results/vecgrep-gap-report.md`).

**Embedder provider lock + incremental ingestion (`@kuralle-agents/rag`):**
- New `IngestManifest` (`InMemoryIngestManifest`, `SqlIngestManifest` over a tagged-template `SqlExecutor` — Durable Object SQLite on CF, `bun:sqlite`/`better-sqlite3` on Node). With a manifest, `RagPipeline`:
  - **locks the index to the embedding model that built it** (`Embedder.id` + dimension) — ingesting or querying with a different model, *even one with the same dimension*, throws instead of silently corrupting relevance (measured baseline: a same-dimension swap returned 0.00 overlap@5 vs truth with zero errors);
  - **skips unchanged documents** via SHA-256 content hash — a stable corpus re-ingests with **zero embed calls** (was: full re-embed every time);
  - **cleans up stale chunks** of changed documents from the vector store (admin stores) and keyword index.
- `Embedder.id` identity added to the interface; `AiSdkEmbedder` derives `provider/modelId`.

**Persistent keyword tier (`@kuralle-agents/rag`):**
- New `KeywordIndex` contract + `Fts5KeywordIndex` — BM25 over SQLite FTS5. On Cloudflare, DO SQLite supports FTS5, so the keyword tier **survives hibernation with zero rebuild** (live-verified); pipeline restart recovery is ~4× faster than the in-memory reseed at 9K chunks.
- `RagPipeline.keywordIndex` keeps the keyword tier in sync at ingest, and re-seeds an empty in-memory index from manifest-skipped docs by chunking alone (zero embeds) — without this, manifest-skip would silently degrade hybrid retrieval to vector-only after a restart.
- **BREAKING:** `KnowledgeFsOptions.bm25` → `keywordIndex`; `FusionRetrieverOptions.bm25` → `keywordIndex` (both now accept any `KeywordIndex`). `BM25Index.size` now counts active documents (previously included removed/overwritten tombstones).

**Multilingual keyword search (`@kuralle-agents/rag`):**
- The shared keyword tokenizer keeps combining marks — Tamil/Sinhala/Hindi words are no longer split at vowel signs (both `BM25Index` and FTS5; previously every Indic-script keyword query missed). `Fts5KeywordIndex` default tokenizer is `unicode61 categories 'L* N* Co Mn Mc'`; new `tokenize` option (`'trigram'` for Chinese/Japanese/Thai substring matching). Tests in Tamil, Sinhala, German, Japanese, Chinese.

**Relevance fixes (`@kuralle-agents/rag`):**
- `KnowledgeFs.search()` now returns hits in BM25 rank order — previously results were filtered in corpus order and truncated, so top-ranked hits could be dropped (measured: exact-term grep tier went from 996 tokens/query at 80% hit rate to **126 tokens/query at 100%**).
- A skip-only ingest no longer erases the manifest's recorded embedder identity (found by the live CF verification).

**Tiered retrieval guidance (`@kuralle-agents/core`, `@kuralle-agents/tools`):**
- `workspace` and vector-retrieval tool descriptions now order the tiers (`ls`/`find` → `grep` for exact terms → semantic search for conceptual questions); `RetrievalQualityChecker.assess()` reports `estimatedTokens` so retrieval token cost is a tracked quality dimension.

**Workers AI embedding path (`@kuralle-agents/vectorize-store` docs):**
- README pairs Vectorize with `workers-ai-provider.textEmbeddingModel` via the `env.AI` binding — live-measured **p50 128 ms / mean 149 ms** per query embedding in-worker (`@cf/baai/bge-m3`) vs p50 235 ms / mean 350 ms for OpenAI from a Fly datacenter.

**Docs:** new "Knowledge & Retrieval" guide (`apps/docs`), `PRIMITIVES.md` gains `KeywordIndex`/`FusionRetriever`/manifest sections, `KNOWLEDGEFS.md` documents the persistent keyword tier.

**Verification:** deterministic before/after benchmark (`bench/vecgrep-gap.bench.ts`) + live spike deployments on Cloudflare (Worker + DO SQLite) and Fly (Bun container), both torn down after capture; sources kept in `examples-deploy/kuralle-rag-smoke{,-fly}`. 93/93 rag tests; `typecheck:all` green.

## 0.9.0 — WhatsApp first-class: Meta API conformance, inbound coalescing, interactive-by-default

Unified bump across the graph (0.8.5 → 0.9.0). Contains **breaking** `@kuralle-agents/messaging-meta` contract fixes (minor bump per repo convention). Grounded in a live conformance audit of every wire payload against developers.facebook.com (June 2026; 27 findings) plus an industry survey of burst-message handling.

**Meta API conformance (`@kuralle-agents/messaging-meta` + `@kuralle-agents/http-client`):**
- **Webhook reply `context` fixed** — real WhatsApp payloads send `{from, id}` (not `{message_id}`): reply correlation (`context.messageId`) was always `undefined`. Normalized properly + new `forwarded`/`frequently_forwarded`/`referred_product` (product-inquiry) fields with a typed `parseProductInquiry` accessor.
- **WhatsApp typing indicators wired** (the 2025 API: read + `typing_indicator` payload) — `markAsRead(id, { typing })` / `sendTypingIndicatorFor(id)`; the "not supported" claim removed.
- **Real HTTP `DELETE`** added to `kuralle-http-client`/GraphAPIClient; all `_method:'DELETE'` POST hacks replaced (templates / personas / ice-breakers). **BREAKING:** `templates.delete` signature; `flows.delete` now truly `DELETE /{flow-id}` (drafts) with new `flows.deprecate` for published flows.
- **Statuses**: `played` (voice-note playback) no longer coerced to `sent`; `pricing.type` (2025 per-message pricing), `error_data`, `biz_opaque_callback_data`, new category enums.
- **Instagram un-gated**: audio/video/file/gif sends (image-only claim was years stale); inbound media keeps its CDN `url` (was dropped → unfetchable); `mark_seen` wired; ice-breakers `get` parse fixed; upload/download replaced with honest unsupported errors (IG messaging is URL-based). **BREAKING:** `sendMedia` is URL-only on IG.
- **Messenger/IG quick-reply payloads parsed** (machine selection no longer lost as plain text); Messenger window-closed error `1545041` classified; `markAsRead` PSID contract documented.
- **Templates**: named parameters (`parameter_format`/`parameter_name`), cursor-paginated `list` (was first-page-only of up to 6000), correct create-response type. **Flows**: `categories` required (API rejects without), `flow_json`/`publish`/`endpoint_uri`. **BREAKING** for `FlowDefinition` users.
- **Default Graph API version v21.0 → v24.0** (v21 nears sunset; window logic already derives from inbound timestamps, unaffected by v24's conversation-object removal).

**Inbound message coalescing (`@kuralle-agents/messaging` + core):**
- `MessagingRouterConfig.inboundCoalescing` — per-thread sliding debounce (default-off; `debounceMs` 3000, `maxWaitMs` 10000 cap, `maxMessages` 10, interactive selections flush immediately): rapid bursts ("hi" / "i want to order" / "the blue one") merge into ONE multimodal turn (image-then-caption → `[FilePart, TextPart]`).
- Core: `consumeAllPendingUserInput` + `mergeUserInputContents` — messages arriving mid-turn drain into one merged next turn instead of N serialized answers (Twilio same-execution / LangGraph-enqueue semantics).

**Interactive replies render by default (`@kuralle-agents/messaging`):**
- The default `StreamMapper` now renders trailing `interactive` stream parts as native buttons/lists via `renderChoices` (moved here from engagement, which re-exports) — flow choices reach WhatsApp without a custom `ResponseMapper`.

**Verification:** WhatsApp workflow E2E suite (`kuralle-engagement/test/whatsapp-workflow-e2e.test.ts`): 8 wire-level workflows — signed webhook → router → engagement policies → runtime → captured Graph payloads (interactive round-trip, closed-window template recovery, media→multimodal, inbound order, status/window updates, consent STOP, window-safe proactive wake).

## 0.8.5 — Agentic harness completion (escalation, wake, memory lifecycle, guardrails, commerce, simulation)

Unified bump across the graph (published 0.7.2 → 0.8.5; the 0.8.0 changes below ship in this same release). **Not breaking** — every surface is additive. Closes the six gaps from the industry-baseline evaluation; most wire dormant seams the v2 recon flagged as "shipped but silent". See its decision record and its decision record.

**Escalation/handoff loop** (`@kuralle-agents/core` + `@kuralle-agents/engagement`):
- `HarnessConfig.escalation { handler, summarize?, model?, recentMessageCount? }` — every escalation path (validator `escalate`, host control, terminal handoff, flow `escalate()`) builds an `EscalationRequest` (state snapshot + recent messages + optional LLM handoff brief) and invokes the handler; outcome recorded on `session.metadata.lastEscalation` and emitted as an `escalation` stream part. Flow escalations notify at the `__escalate` pause; a one-shot latch prevents double-fire after resume.
- `runtime.resumeFromEscalation(sessionId, { resolutionSummary? })` — appends the human's resolution as context, clears parked flow/signal state, resumes the bot.
- Engagement bridge: `createOwnershipEscalationHandler({ ownership, notify? })` claims thread ownership (bot sends suppressed by `ownershipGate`); `resolveEscalation` releases + resumes.

**Proactive turns + one scheduler contract**:
- `RunOptions.wake { reason, payload? }` — agent-initiated turns (cart abandonment, follow-ups): a system wake note enters history, free-conversation agents re-engage, active flows re-prompt their current step; `wake` stream part emitted.
- `Scheduler`/`ScheduledJob` contract moved to core (engagement re-exports; `SendJob` = alias). `createWakeJobRunner(runtime, { deliver })` runs wake jobs and hands the produced parts to the host's delivery (e.g. the window-safe outbound pipeline). `createScheduleFollowupTool(scheduler)` lets the agent schedule its own follow-ups.
- **Cloudflare DO-alarm backend**: `KuralleAgent.wakeScheduler()` / `scheduleWake()` ride the agents SDK's durable scheduling; wake turns persist + broadcast through CF's machinery. Workerd parity test included.

**Memory lifecycle**:
- `HarnessConfig.compaction { model?, triggerTokens?, keepRecentMessages?, summaryPrompt? }` — post-turn history summarization (off the latency path); kept tail always starts at a user message. Emits `context-compacted` / `compaction-skipped`.
- Context-overflow recovery wired (the classifier shipped since v2 with zero callers): on a provider overflow the runtime strips the failed turn's partials, force-compacts once, retries once; emits `context-overflow-recovered`.
- `createFactMemoryService({ store, model })` — LLM fact extraction with merge-on-ingest (existing facts + transcript → complete updated list), per-user block on any `PersistentMemoryStore` (file / Postgres / Redis / CF DO SQLite), injection-scanned writes. Identity verified end-to-end: messaging `customerId` → `RunOptions.userId` → memory owner.

**Real guardrails** (the pipeline existed; the guards now ship):
- `createPromptInjectionGuard()` (audited pattern set shared with memory-write scanning), `createPiiInputGuard()`/`createPiiOutputGuard()` (Luhn-validated cards + emails by default, opt-in phone/IBAN, redact-or-block), `createModerationGuard()`/`createModerationOutputGuard()` (temperature-0 LLM classifier, fail-open default), `createGroundingValidator()` (the productized H6 grounding gate: completed-action claims vs tool calls/state/citations, rewrite-not-block).
- Pre-turn blocks now emit `safety-blocked { moderator, rationale, userFacingMessage }`.

**Commerce**:
- New `@kuralle-agents/commerce`: integer minor-unit `Money`, `ProductCatalog` contract, durable cart tools in flow state (`product_search`/`cart_add`/`cart_remove`/`cart_view`), idempotent `createOrderTool` (content-key ledger + in-flight coalescing — a proven production pattern, productized), `toWhatsAppProductList` mapper.
- `@kuralle-agents/messaging-meta` WhatsApp commerce surface: `sendProduct`, `sendProductList` (limits validated), `sendCatalog`, `sendAddressRequest`; inbound `order` webhooks normalized with typed `parseInboundOrder` / `parseInboundAddress`. Payment messages deliberately out of scope.

**Simulated-user eval + LLM judge** (`@kuralle-agents/core`):
- `simulateConversation({ runtime, persona, userModel })` — an LLM persona (profile/goal/temperament) drives a real runtime to goal-met/give-up/max-turns; `createJudge({ model, dimensions? })` scores transcripts 1–5 on goal completion, grounding, tone, efficiency; `runSimulationSuite` is the CI gate (gave-up always fails).

**New exports** also include: `ToolContext`, `ActionContext`, `AnyTool`, `compactMessages`, `isContextOverflowError`, `buildEscalationRequest`, `ensureSessionMetadata`.

## 0.8.0 — Multimodal intake + Cloudflare durable HITL (BREAKING)

Unified minor bump across the graph (0.7.2 → 0.8.0). **Breaking type change**: the runtime accepts multimodal user input instead of only `string`. See its decision record.

**Cloudflare (`@kuralle-agents/cf-agent`):**
- **Upgraded to `agents@^0.15` + `@cloudflare/ai-chat@^0.8.4`** (was `agents@0.11.5` + `ai-chat@0.1.x`, a peer mismatch that crashed the chat path with `this.mcp.ensureJsonSchema is not a function`). `KuralleAgent` needed no API changes.
- **Multimodal on CF** — `KuralleAgent.getLastUserInput` now maps CF UIMessage file parts to `UserInputContent` (was text-only), so prescription images / uploads reach the model. Exposed as `lastUserInputFromMessages`.
- **Durable human-in-the-loop on CF** — new `KuralleAgent.resumeWithSignal(signal)` + a `POST …/resume` route deliver a durable signal to a suspended run, then persist + broadcast the resumed assistant turn. This is the "payment link → resume the conversation" primitive.
- **Fix: durable runs now persist on CF** — `BridgeSessionStore` round-trips the Kuralle run journal (`durableRuns`) through `OrchestrationStore`; without it, durable tools and suspend/resume failed with "Run not found".
- **Fix (core): `RunContext.resetCallsites()` at flow entry** — anchors a flow's durable effect callsites to the flow itself, so a run entered via `enter_flow` (after an answering turn) resumes correctly instead of re-suspending on a callsite mismatch.
- New exports: core — `SignalDelivery`, `SessionDurableRuns`, `PersistedRun`, `DURABLE_RUNS_KEY`. Verified end-to-end on a live Workers+DO deploy (`apps/playground/pharmacy-rx-agent`): multimodal intake, multi-tenant DO isolation, persistent cart, and payment-link → resume → order-complete.

**Why:** the runtime accepted only text — `RunOptions.input` was `string`, and every ingress collapsed rich input to text *before* it reached the runtime (web `extractInputFromBody` filtered UIMessage parts to text-only; messaging `resolveInbound` returned `m.text ?? ''` and never read `m.media`). A photo, document, or WhatsApp voice note arrived as an empty string. This blocks every vertical whose first input is an image or voice note.

**Breaking:**
- `RunOptions.input: string` → **`UserInputContent`** (= the AI SDK `UserContent`: `string | Array<TextPart | ImagePart | FilePart>`). A plain string is still valid, so text-only callers compile unchanged — but anyone who *declared* `input: string` must widen it.
- `ChannelPolicy.resolveInbound(m)` and `@kuralle-agents/messaging`'s `InboundResolverPlugin` now return `{ input: UserInputContent; selection? }`. Custom resolver/policy implementations must widen their return type.

**What's new:**
- **Multimodal threads straight to the model.** `openRun` builds `{ role: 'user', content }` from `UserInputContent` with no translation — Kuralle is AI-SDK-native, so we adopt the AI SDK's own content type rather than inventing a media type.
- **Web ingress** (`createKuralleChatRouter`): UIMessage `parts` → content — text → `TextPart`, `{type:'file', url, mediaType}` → `FilePart{ data: url }` (the ai-chatbot upload shape). Text-only input collapses back to a plain string (byte-identical text flows).
- **Messaging ingress**: `createMessagingRouter` runs the new `attachInboundMedia(message, input, platform)` after the resolver chain — it downloads inbound media via `platform.downloadMedia(id)` (or passes a hosted `url` through), base64-encodes it, and attaches a `FilePart` + caption `TextPart`. Channel-agnostic; works with or without the engagement policy layer.
- **Voice notes**: `HarnessConfig.transcriptionModel?: TranscriptionModel` (AI SDK). When set, inbound audio parts are transcribed to text before the turn (so voice works on text-only models); when unset, audio passes through to audio-capable models (e.g. Gemini). `data:`/`http(s)` audio sources are normalized for `transcribe`.
- **New exports** — `@kuralle-agents/core`: `UserInputContent`, `userInputToText`, `hasMediaParts`, `transcribeAudioParts`. `@kuralle-agents/messaging`: `attachInboundMedia`.

**Durability invariant:** `FilePart.data` flowing through the runtime must be JSON-serializable (base64 string / data URL / https URL), never a raw `Buffer` — `RunState.messages`, `session.messages`, and the pending-input buffer are all persisted through the `SessionStore`.

**Not multimodal:** the legacy `/api/flow/*` string-only endpoints (`flowManager.process(input: string)`) degrade media to its text projection — a capability limit of that older subsystem, not the runtime path.

## 0.7.2 — Wire provider prompt caching (was shipped-but-dead)

Unified patch bump across the graph (0.7.1 → 0.7.2). `runtime/promptCache.ts` shipped full provider-prompt-cache support since 0.6.x but had **zero callers** and was **not exported** — every speaking-turn `streamText` ran with no `providerOptions`, so OpenAI `promptCacheKey` was never set and Anthropic `cache_control` was never applied. Found by the syrinx team's loop-back; verified (zero callers, not exported, no `providerOptions` on `TextDriver:77` / `extractionTurn:39`).

**What's new:**
- **Prompt caching is now wired and default-on**, gated by conservative provider detectors. New single owner `applyPromptCache(model, sessionId, messages)` is called from both `streamText` sites (`TextDriver`, `extractionTurn`):
  - **Anthropic** → `cache_control` breakpoints (caches the `system + tools` prefix + recent history; ~up to 75% input-cost + a TTFT chunk off every multi-turn turn — Anthropic caching is opt-in, so this was 0% before).
  - **OpenAI Responses** → `promptCacheKey = sessionId` (pins same-session turns to one cache slot) + `truncation: 'auto'` overflow safety net.
  - Other providers → untouched (no-op).
- The helpers (`applyPromptCache`, `applyAnthropicCacheControl`, `buildOpenAIResponsesProviderOptions`, `isAnthropicLanguageModel`, `isOpenAIResponsesModel`) are now **exported from `@kuralle-agents/core`** so custom drivers can opt in.

Prompt assembly was already cache-friendly (static instructions first, volatile RAG/memory appended last), so this is a pure wiring fix. No API change, not breaking. Note: the separate Layer-2 *retrieval* cache is still unwired — a distinct follow-up.

**Validated live** (`packages/e2e-tests/prompt-cache-validation.md`):
- **OpenAI** — cache HIT confirmed through the shipped helper: turn 1 `cacheReadTokens=0`, turns 2–4 `=10240` (~99% of the prompt cached → ~half the input cost on repeat turns).
- **Anthropic** — wired + unit-tested; not live-validated (no key in env).
- **Gemini** — kuralle wires nothing (implicit caching is parameter-free), but implicit caching is best-effort and **did not fire** in a 4-turn live probe; *guaranteed* Gemini caching needs explicit `CachedContent`, which is **not** wired (open follow-up).
- **Cloudflare AI Gateway** — the provider prompt cache rides through the gateway (request-body fields are forwarded); the gateway's own response cache is a separate, byte-identical, off-by-default layer.

## 0.7.1 — On-demand retrieval (declared grounding contract)

Unified patch bump across the graph (0.7.0 → 0.7.1). No API removed, no type change, not breaking; the existing `knowledge.autoRetrieve` boolean now declares **who invokes retrieval** — the runtime or the model. See its decision record.

**What's new:**
- **`knowledge.autoRetrieve: false` now means on-demand, not off.** Previously `false` left knowledge inert (declared, nothing wired). It now skips pre-injection **and** wires a core `knowledge_search` global tool, so the model retrieves only when it answers — routing/dispatch turns pay **zero** retrieval tax (grounding becomes model-discretion). `true` (default) is unchanged: pre-inject before every answering turn.
- The pre-injection provider and the `knowledge_search` tool are mutually exclusive, selected by the existing boolean — no new mode field, no behavior fork to configure.

**Behavior change (non-breaking, no type change):**
- Agents that set `knowledge.autoRetrieve: false` previously got no retrieval at all; they now expose `knowledge_search` to the model. Drop `knowledge` entirely to disable retrieval.
- **Unchanged:** `knowledge.autoRetrieve: true`/omitted (guaranteed pre-injection); node-level `grounding.knowledge.autoRetrieve: false` (per-node opt-out).

## 0.7.0 — Derived host routing (BREAKING)

Unified minor bump across the graph (0.6.1 → 0.7.0). **Breaking**: removes the public routing-mode surface. Routing behavior is now derived from **(agent shape × driver output capability)** — see its decision record.

**Removed (breaking):**
- `routing.mode`, `routing.always`, `routing.default` from `RoutingPolicy` — there is no routing-mode enum.
- Lexical/deterministic routing (`deterministicRouteMatch`, `keywordRouteFallback`) on the hot path — routing is **model-reasoned only** (multilingual-safe).
- Stale `Flow.hybrid` / "hybrid mode" doc references (the feature was removed in the v2 reset).

**What's new:**
- **Derived routing** — answering agents (`instructions`/`flows`/`tools`/…) fold `enter_flow` + `transfer_to_agent` control tools into the speaking turn; routes/agents-only agents with no answering surface become **silent pure dispatchers**. A keep turn pays **zero** routing cost (the per-turn `generateObject` selector is gone — keep-turn TTFT ~2.9s → ~0.9s in the A/B smoke).
- **Lazy host-control guard** — a forgot-to-route net that classifies **only** when an answering turn ends with no control tool and no substantive text. Answered + main-control turns make zero classifier calls; the guard has a single owner (the host loop) and is evaluated at most once per turn. Emits `host-guard` telemetry.
- **`routing.dispatch?: 'strict'`** — optional compliance override (no user-facing dispatch text) for controlled-TTS / text channels. Strictness otherwise derives from the driver's output capability (native-realtime stays advisory, consistent with an earlier decision).
- **`routing.model`** — still selects the control-reasoning model for the guard / pure-dispatcher classifier.

**Migration:**
- Remove `routing.mode` (`'tools'`/`'structured'`/`'llm'`), `routing.always`, `routing.default` — populate `flows`/`routes`/`agents`/`instructions` and the runtime derives behavior. Model a fallback as a normal semantic route/child agent, not `routing.default`.
- A routes-only triage agent now derives as a **silent pure dispatcher** (no fallback prose) — add `instructions` if it must speak before routing.
- Internal: `HostControlContext.guard` removed (drivers no longer own the guard). No consumer action unless you extended a `ChannelDriver`.

## 0.6.1 — zod 4

Unified patch bump across the graph (0.6.0 → 0.6.1). Migrates the framework from **zod 3 to zod 4**.

- All packages now depend on (and peer) **`zod@^4`**. Consumers should be on zod 4.
- Internals migrated off the zod-3-only `zod-to-json-schema` to zod 4's native `z.toJSONSchema`; `z.record` calls updated to the 2-arg form; tool-type inference fixes.
- `wrapAiSdkTool()` now accepts any structurally-compatible AI SDK tool (decoupled from a specific `ai` instance/version).
- Resolves the `@kuralle-agents/cf-agent` npm `ERESOLVE` (the `agents` SDK peers `zod@^4`; the dependency graph now matches).

No API changes beyond the zod peer bump. Verified: full build + `typecheck:all` + test suite green.

## 0.6.0 — Filesystem, Skills, Working memory (BREAKING: `AgentConfig.tools`)

Unified minor bump across the graph (0.5.0 → 0.6.0). One breaking change (the tool-model rename below); the rest is additive. New packages: **`@kuralle-agents/fs`**, **`@kuralle-agents/skills`**.

**Breaking:** `AgentConfig.effectTools` is renamed to `AgentConfig.tools` (durable `Record<string, AnyTool>`). The old raw `tools?: ToolSet` field on `AgentConfig` is **removed** — third-party AI SDK tools must use `wrapAiSdkTool()`.

**Migration:**
- `effectTools: { myTool }` → `tools: { myTool }`
- Remove paired `tools: buildToolSet({... })` on the agent when it duplicated executors — flow nodes still use `buildToolSet` for model-visible schema.
- Raw AI SDK `tool({ execute })` on the agent → `tools: { name: wrapAiSdkTool('name', aiTool) }`

**What's new:**
- **`wrapAiSdkTool(name, aiTool)`** — adapts AI SDK tools for journaled execution through `CoreToolExecutor`.
- **`scripts/check-no-raw-tool-execute.sh`** — CI guard wired into `typecheck:all`; fails if raw `execute` could reach `streamText`.
- Host-reply (off-flow) tools route through the durable journal via `buildToolSet` + registered executors.

**Filesystem (`@kuralle-agents/fs`, new):** portable `FileSystem` interface + `InMemoryFs` (zero `node:*`, Node + Workers); one durable `workspace` tool (`ls/cat/grep/find/read/write/edit`); `AgentConfig.workspace` (read-only by default). `CompositeFileSystem` routes by path prefix (mount `/kb`, `/docs`, `/scratch`…). `KnowledgeFs` (in `@kuralle-agents/rag`) exposes a vector store as a read-only filesystem (`cat` = chunk reassembly, optional BM25 grep, RBAC tree-prune).

**Skills (`@kuralle-agents/skills`, new):** Anthropic-style Agent Skills — `SKILL.md` + 3-level progressive disclosure via a `SkillsCapability`; `AgentConfig.skills`; scripts are allow-listed durable tools.

**Working memory:** `AgentConfig.memory.workingMemory` — durable USER/MEMORY blocks loaded into the prompt + maintained by the model via the auto-registered `memory_block` tool (Mastra-style directive injected automatically). Stores: `InMemory`, `File` (`~/.kuralle/memories`), `Postgres`, `Redis`/Upstash, and CF-native `SqlPersistentMemoryStore` (DO SQLite). Composite: `RoutedPersistentMemoryStore` (by scope) + `TieredPersistentMemoryStore` (read-through cache). See the new **Memory** guide.

**Cloudflare:** every new primitive ships day-1 Workers support (`workerd` parity tests; cf-agent auto-wires DO-SQLite working memory, zero config).

## 0.5.0 — AI-SDK-native by default (BREAKING: web stream output)

Unified minor bump across the graph (0.4.1 → 0.5.0). **Breaking wire-format change for web consumers of `POST /api/chat/sse`** — no compatibility shim on the default path.

**Breaking:** the default web/HTTP streaming response is now an AI SDK `UIMessageStream` (`useChat` works with **no bridge**). Raw `HarnessStreamPart` JSON-SSE moved to opt-in: append `?format=raw` to `/api/chat/sse` (and `/api/flow/sse`). `createKuralleSseChatRouter` remains the explicit raw-SSE-only router.

**Consumer migration:**
- **Web/React:** delete any hand-rolled `HarnessStreamPart` → `UIMessageChunk` bridge; point `useChat` at `POST /api/chat/sse` (default). Read Kuralle orchestration events from `message.parts` (persistent `data-kuralle-*`) or `useChat({ onData })` (transient telemetry).
- **Raw JSON-SSE consumers** (curl, Studio, custom transports): append `?format=raw` to preserve the 0.4.x wire.

**What's new:**
- **`harnessToUIMessageStream()`** — pure adapter from `HarnessStreamPart` to AI SDK `UIMessageStream`; native text/tool parts + typed `data-kuralle-*` for Kuralle orchestration residue.
- **`TurnHandle.toUIMessageStreamResponse()`** — convenience returning `createUIMessageStreamResponse`.
- **`KuralleUIMessage` / `KuralleDataParts`** — typed `UIMessage` for compile-time-safe `message.parts` and `onData`.
- **`createKuralleChatRouter`** — `POST /api/chat/sse` defaults to native `UIMessageStream`; accepts `useChat`-shaped `{ messages: UIMessage[] }` inbound.

**Unchanged:** `HarnessStreamPart`, `toResponseStream('sse'|'ndjson')`, cascaded voice, messaging, WebSocket widget (still `HarnessStreamPart` JSON).

## 0.4.1 — Streaming follow-up fixes (patch)

Patch across the graph (0.4.0 -> 0.4.1). Backward-compatible fixes to the 0.4.0 streaming release; no API changes.

- **Fix (behavioral):** off-script answers in the collect **digression** path were emitted **twice** — `runFlow`'s `collectDigression` re-emitted the assistant-text lifecycle on top of the one `ChannelDriver.runAgentTurn` already produces. The driver is now the single owner of the assistant-text lifecycle; the digression path only appends the answer to history. (Regression test added asserting a single answer emit + single re-ask.)
- **Docs (shipped):** the published `@kuralle-agents/core` `guides/` (GETTING_STARTED / TOOLS / FLOWS / AGENTS) still showed `part.text` in streaming snippets — migrated to `part.payload.delta` for the 0.4.0 lifecycle. Added `scripts/check-no-stale-text-delta.sh` to fail CI on stale `text-delta.text` reads/constructors in publishable files.
- **Internal:** cleared pre-existing `typecheck:all` drift in test/example tsconfigs and the playground (`'a'`→`Transition`, optional-`decide` narrowing, dual hook-vs-wire `RunContext` in a test, `part.text`→`part.payload.delta` in playground CLIs); the full `typecheck:all` gate (incl. playground + lint) is green again. No shipped-API change.

## 0.4.0 — Streaming-by-default (BREAKING: assistant-text event lifecycle)

Unified minor bump across the graph (0.3.20 -> 0.4.0). **Breaking event-protocol change — no compatibility shim.**

**Breaking:** the single-shot `{ type: 'text-delta'; text: string }` is **removed** and replaced with a four-variant assistant-text lifecycle on `HarnessStreamPart` (`types/stream.ts`), the voice union (`types/voice.ts`), and `AgentStreamPart` (`types/processors.ts`):

```
| { type: 'text-start'; id: string }
| { type: 'text-delta'; id: string; delta: string }   // was { text: string }
| { type: 'text-end'; id: string }
| { type: 'text-cancel'; id: string; reason: string }
```

**Consumer migration:** read `part.payload.delta` (not `part.text`); handle (or ignore) `text-start`/`text-end`/`text-cancel`. Mirrors AI SDK v6 `UIMessageChunk`.

**What's new:**
- **Streaming-by-default.** Replies stream incrementally up to the smallest guardrail boundary each attached gate permits — `token` (no gate), `sentence` (per-utterance gate), `turn` (whole-answer grounding gate). An ungated reply now emits multiple `text-delta`s with the first before turn-end (was: one buffered delta at turn-end).
- **Shared `speakGated` emission path** for text + native-realtime voice; `SentenceAggregator` + `resolveStreamMode` + a `streamGranularity?: 'sentence'|'turn'` field on output processors / validation policies (default `turn`, safe).
- **Cascaded LiveKit TTFT** drops to first-token latency (`aria_runtime_ttft` fires on the first delta).
- **Native realtime gate is advisory (REQ-9):** the provider speaks audio before any gate runs, so a whole-answer gate on native realtime emits a `safety-*` event + correction post-hoc but cannot un-speak audio. Preventive only on text/cascaded. See an earlier decision.

> Known (non-shipping): `bun run typecheck:all` reports pre-existing drift in 4 test/example tsconfigs (unrelated to streaming; not in published tarballs, which build from `src`). Tracked as a follow-up; the published packages build clean.

## 0.3.20 — ValidateInput.state (grounding validators can see flow state)

Patch across the graph (0.3.19 -> 0.3.20). `ValidateInput` now carries `state` (the
flow `runState.state`), passed by `applyPostTurnPolicies`. A grounding `ValidationCapability`
can now ground a claim against evidence an ACTION node wrote (e.g. `state.orderRef`
after a create-order tool) — which `toolCallsMade` (this turn`s model tool calls
only) does NOT capture. Without this, a validator that grounds order/delivery
claims on `toolCallsMade` false-positives on the reply turn that follows an action
node (the tool ran in the prior node). Additive: existing validators ignore the
new field. core 485/485.

## 0.3.19 — Export pending-input buffer helpers (custom ChannelDriver support)

Patch across the graph (0.3.18 -> 0.3.19). `setPendingUserInput`/`consumePendingUserInput`/`peekPendingUserInput`/`hasPendingUserInput` are now exported from `@kuralle-agents/core/runtime`. A custom `ChannelDriver` (or a test fake) needs `consumePendingUserInput` to implement `awaitUser` the same FIFO-aware way the built-in drivers do — since 0.3.13 (H3) the buffer is an ordered queue, so hand-reading the workingMemory key as a string silently breaks. No behavior change; export-only.

## 0.3.18 — H6: author-reachable confidence/grounding gate

Patch across the graph (0.3.17 -> 0.3.18). Completes the text-hardening backlog.
The `ValidationCapability` machinery existed but was unreachable (`resolvePolicies`
hardcoded `validationPolicies:[]`, `agentTurn` hardcoded `knowledgeCitations:[]`),
and a `block` decision emitted a fallback then continued as if the turn happened —
no engine backstop against a hallucination. H6 (additive-by-config, NO flag):
- `AgentConfig.validate` / `refine` are wired through `resolveAgentPolicies`.
- Retrieved `SourceRef[]` citations from gather are threaded into `ValidateInput`
  (the missing half of W3 grounding) + a `knowledge-citation` audit entry.
- A `block` / `escalate` validation decision now emits a SAFE message (never the
  un-validated model draft) and reroutes via the existing W1 recover/escalate
  control path — instead of streaming the reply and continuing.
- New `ReplyNode.confidenceGate { min, onLow }`: a low-confidence turn routes to
  `onLow` + a low-confidence escalation audit entry. `TurnResult.confidence`
  populated from the validation decision.
Additive: an agent with no `validate`/`refine`/`confidenceGate` is byte-identical
to 0.3.17 (parity test — empty policy list short-circuits to the model text).
core 485/485; W1/W9/H1/H4/H5/confirm-gate/parking/turn-lock green.

## 0.3.17 — H5: in-flow digression / answer-then-resume (default OFF)

Patch across the graph (0.3.16 -> 0.3.17). Behind the same default-OFF flag as H1
(`agent.experimental.outOfBandControl`). Today once a flow is active, host routing
never re-runs and an off-script question at a `collect` node is discarded (field
stays unfilled → re-ask). When ON: if a turn's input at a collect does NOT advance
it, a digression step runs — (a) `selectHostTarget` (excluding the active flow) can
route/handoff or **switch to another flow** with the current flow **parked** at its
node (`__flowPark`; resumed when the switched flow ends), or (b) the off-script
question is answered by one free-conversation turn and the collect re-asks (flow
resumes next turn). On-topic input still collects; multi-intent split deferred.
New `src/flow/collectDigression.ts`; `normalizeTransition` gains a `switchFlow`
variant (type-only; produced only by digression). Flag OFF: collect loop
byte-identical (parity test). core 478/478; W1/W9/H1/H4/confirm-gate/parking/
turn-lock green.

## 0.3.16 — H4: constrained-enum decide + code-first routing

Patch across the graph (0.3.15 -> 0.3.16). Generalizes W9's deterministic pattern
to all `withChoices` `decide` nodes. (1) Choice-decides now build the
`generateObject` schema from the node's actual choice ids as a closed `z.enum`
(+ a reserved `__none` member so the model can decline rather than be forced into
a wrong branch) — an invalid branch is structurally impossible, replacing the old
soft prompt-instruction. (2) `matchChoiceFromInput` resolves a clear input (exact
id/label or unambiguous keyword) in code and SKIPS the LLM entirely; the pinned
temp-0 control model (H2) only arbitrates genuine ambiguity. (3) `select.ts` host
routing tries a deterministic route/keyword match BEFORE `generateObject` (was
LLM-first with a post-hoc fallback). Conservative guard: the enum + code-first
apply only when the node has `choices` and the schema is exactly
`z.object({ choice: z.string() })`; other shapes keep legacy behavior. confirmGate
and choice-less decides untouched. New `src/flow/choiceMatch.ts`. core 471/471;
W1/W9/H1/confirm-gate/parking/turn-lock green.

## 0.3.15 — H7a: interim filler + per-tool timeout + extraction telemetry

Patch across the graph (0.3.14 -> 0.3.15). First half of H7 (tool execution
hardening). (1) The previously-dead `onInterim` callback is wired in `Runtime` to
emit a `text-delta` filler, so a slow tool with `interim`/`interimAfterMs` speaks
instead of going silent. (2) New per-tool `Tool.timeoutMs`: `CoreToolExecutor`
races execution against a `ToolTimeoutError`, which flows through
`executeModelToolCall` → `toolErrorResult` → the W1 recovery boundary — closing
the "hung tool throws nothing, so W1 never fires" hole (every peer agent engine
has a timeout/duration guard). Timer is cleared on abort/success/error and
`unref`'d; unset `timeoutMs` = no change. (3) The modeled-but-never-emitted
extraction telemetry (`flow.extraction.submission` with fieldsAccepted/Rejected,
`flow.extraction.update`) is now emitted from the collect path and fed to the
observability hook. (4) Legacy `tools/Tool.ts` `filler`/`estimatedDurationMs`
converge onto the canonical `interim`/`interimAfterMs` (deprecated aliases kept).
Execution modes (immediate/post_speech/async) are H7b. core 458/458;
W1/W9/H1/parking/turn-lock green.

## 0.3.14 — H1: out-of-band control evaluator for flow reply nodes (default OFF)

Patch across the graph (0.3.13 -> 0.3.14). The W2 keystone, scoped to flow reply
nodes. Behind a default-OFF flag
`agent.experimental.outOfBandControl`. When ON: a flow reply node's model-visible
tool dict EXCLUDES flow-transition control tools (handoff/transfer_to_agent/final/
escalate/recover — still registered in the executor, just not offered to the
speaker), and a deterministic `evaluateReplyControl` decides the transition from
structured signals — `interrupted` → redispatch, a data-tool/W1 control-result
shape → transition, else `node.next` → transition. So flow routing is decided by
the flow, not by the model picking a control tool mid-generation. NO new LLM calls
(purely deterministic). Free conversation (`hostLoop.runFreeConversation`, marked
`ResolvedNode.freeConversation`) is untouched — it keeps its model control channel.
Flag OFF reproduces 0.3.13 byte-for-byte (the original dispatch branch is preserved
verbatim; parity test). Pre-emission reask + the semantic classifier are deferred
to H6. core 449/449; W1/W9/parking/turn-lock green.

## 0.3.13 — H3: per-session turn lock + FIFO input inbox

Patch across the graph (0.3.12 -> 0.3.13). Second hardening chunk
(hardening plan, Phase 0). Closes the overlapping-turn race:
two concurrent `runtime.run()` on the SAME session (double-tap, retry-on-slow-
stream, multi-tab, reconnect) used to interleave — both buffered into one
overwritable input slot (last-writer-wins ate a message) and an empty consume
threw. Now `Runtime.run` serializes turns per session via the (previously
unwired) `SessionMutex` — the second turn's body, including its `openRun` buffer
write, does not start until the first finishes; different sessions stay
concurrent. The input buffer is an ordered FIFO (`setPendingUserInput` enqueues,
`consumePendingUserInput` dequeues oldest and returns '' instead of throwing;
legacy string slots coerce to a single-item queue). `turnInputConsumed` and all
interactive-node parking are unchanged. core 438/438, engagement 107/107,
hono 52/52; W1/W9/collect-parking suites green.

## 0.3.12 — H2: pinned temperature-0 control-model channel

Patch across the graph (0.3.11 -> 0.3.12). First chunk of the core-primitive
hardening plan, the cheapest highest-leverage
anti-flakiness lever. The control path (routing, `decide`/`runStructured`, collect
extraction) ran on the same model that speaks to the user, at default sampling —
so identical prompts produced different routes/branches/extractions across
providers and runs (the gpt-4.1-mini-vs-gemini-3.1-flash-lite reliability gap).
New optional `AgentConfig.controlModel` (resolved onto `RunContext.controlModel`,
defaulting to the speaker model) pins every control-path LLM call to a single
model at `temperature: 0`. The speaker path (`runAgentTurn`) is unchanged. Set
`controlModel` to pin control to a reliable provider independent of the speaker.
core 430/430, engagement 107/107, hono 52/52.

## 0.3.11 — Voice paused: text is the primary channel

Patch across the graph (0.3.10 -> 0.3.11). Kuralle now hardens **text as the
primary primitive**; provider-native realtime voice is **paused**. The realtime
`VoiceDriver` is removed from the package's headline API (`@kuralle-agents/core`
no longer exports it) — it remains intact behind the `@kuralle-agents/core/runtime`
subpath for `@kuralle-agents/realtime-audio`, which is unchanged. No realtime model
code was deleted. `@kuralle-agents/livekit-plugin` (cascaded STT → Kuralle text
runtime → TTS) is unaffected — it runs on `runtime.run` (the default TextDriver),
not the realtime VoiceDriver.

Also fixed a VoiceDriver/TextDriver parity escape hatch: `VoiceDriver.runStructured`
now applies the same single-choice-id constraint TextDriver already had, so a
`decide` node behaves identically on both channels. READMEs note the pause + point
to cascaded voice. core 422/422, engagement 107/107, hono 52/52.

## 0.3.10 — W3 per-node context scoping

Patch across the graph (0.3.9 -> 0.3.10). Third chunk of the conversational-stability
program. Grounding was assembled once per turn, agent-wide, for reply
nodes only — every node retrieved with the same KB scope and the same query
(`latestUserMessage`), even when the node's job had nothing to do with the user's
last words. W3 makes grounding node-scoped on reply nodes (the ElevenLabs per-node
context-assembly model; `decide` stays a KB-free out-of-band evaluator, `collect`
extraction stays silent). New optional `ReplyNode.grounding` (`NodeGrounding`): a
node-specific `query` (string or `(state, history) => string`), a node `knowledge`
subset merged over the agent's (`filter`/`topK`/`maxOutputTokens`/`autoRetrieve:false`),
and node `memory` (`preload:false`/`tokenBudget`). `runGatherPhase(ctx, scope?)` is
now node-aware; `AutoRetrieveProvider.retrieve`/`MemoryService.preload` take an
optional `GatherScope`. No provider changes — the per-call query+overrides path
already existed. Additive: no `grounding` ⇒ byte-identical to today (locked by a
baseline-equality test). core 422/422.

## 0.3.9 — W9 deterministic mutation/confirm gate

Patch across the graph (0.3.8 -> 0.3.9). Second chunk of the conversational-stability
program. A confirm-before-mutate step was a `decide` node whose choice
was classified by the LLM — an off-script reply or a bare value could be
mis-classified as "confirm" and fire the mutation without an explicit human yes.
New `confirmGate()` node builder (a `DecideNode` with a `confirmGate` config — no
new node kind) whose advance decision is parsed **in code** by `parseConfirmation`,
never the model. Conservative precedence: **decline wins → interrogative/off-script
is ambiguous → affirm only when affirm-dominant**; multilingual (English + Sinhala +
Tamil, script and romanized). The runtime branches the decide dispatch on
`confirmGate` and never calls `runStructured`. Off-script/ambiguous re-asks (stay);
explicit negative routes to `onDecline`; post-END never re-fires a completed
mutation (locked by test via `hostLoop` reset + `__completedFlows`). core 415/415.

## 0.3.8 — W1 runtime recovery boundary (errors degrade, never abort)

Patch across the graph (0.3.7 -> 0.3.8). First chunk of the conversational-stability
program. A tool throw, a ToolValidationError (bad args), or a
maxOscillations cap no longer aborts the session: errors degrade in-turn (safe
message + non-fatal `error` event) and route to an `escalate` node or a graceful
`error_degraded` end. New `executeModelToolCall` boundary (TextDriver+VoiceDriver),
`degradeFlowError`, TurnControl escalate/recover. core 391/391.


## 0.3.7 — Fix: global tools must be executable

`agent.globalTools` were made model-visible (0.3.6) but their executors were not
registered in the tool executor, so a model call to a global tool failed. Now
registered alongside `tools`; visibility remains gated (not exposed during
non-speaking collect extraction). Regression test `test/core-agent/global-tools.test.ts`.

## 0.3.6 — Agent base layer: base instructions + global tools in every node

Patch across the package graph (`0.3.5 → 0.3.6`).

### Added (`@kuralle-agents/core`)

- **Agent base layer composed into every flow node.** Previously each node ran
  with only its own `instructions`; the agent's global `instructions` reached just
  the off-flow host reply, so there was no shared persona/safety/grounding floor.
  Now the agent `instructions` are composed as a **prefix** into every node turn's
  system prompt (`runAgentTurn`/`runStructured`/`runExtraction`); node instructions
  layer on top. (ElevenLabs-style "base prompt regardless of active node".)
- **`AgentConfig.globalTools`** — a designated, safe allow-list of tools made
  model-visible in every **speaking** turn (e.g. a returns/FAQ KB lookup callable
  mid-flow). Safety invariant: NOT all `tools` (mutating tools stay
  flow-gated), and NOT exposed during non-speaking collect extraction.
- Implemented for TextDriver and VoiceDriver. ADR its decision record. core 383/383.

**Behavior change:** node prompts now also carry the agent persona/safety. Apps
that relied on nodes NOT seeing `agent.instructions` should move that text out.

## 0.3.5 — Non-speaking collect extraction (structural anti-narration backstop)

Patch across the package graph (`0.3.4 → 0.3.5`).

### Added / Fixed (`@kuralle-agents/core`)

- **`collect` extraction no longer speaks.** A collect node used to run one agent
  turn that both extracted fields AND emitted free-form prose; that prose drifted
  into claims contradicting flow state ("order placed", "visit the website", "will
  be delivered") and no prompt rule could deterministically stop it. Extraction is
  now a non-speaking operation — the **invariant**: a collect turn may change
  structured state but may NOT author user-facing text.
  - New `ChannelDriver.runExtraction` + shared `runSilentExtraction` helper: runs
    the submit tool to pull fields, emits no `text-delta`/`turn-end`, appends no
    model prose. Implemented for **TextDriver and VoiceDriver** (voice extracts via
    the text model, never speaking the realtime provider during collection).
  - New `CollectNode.ask(missing, state)`: deterministic, framework-emitted
    question for missing fields, with a safe default that never references a
    downstream outcome. `instructions` is now extraction-only (never user-visible).
- Proven model-independent via a malicious-mock model (always returns "I've
  processed your order") whose text is never emitted/appended. Voice/text parity
  (INV-3) preserved. core 381/381.

## 0.3.4 — Collect projects all collected fields to onComplete (no silent drop of optionals)

Patch across the package graph (`0.3.3 → 0.3.4`).

### Fixed (`@kuralle-agents/core`)

- **`collect` now hands `onComplete` every field it collected, not just the
  required subset.** `projectCollectData` previously projected only `node.required`,
  so optional schema fields a node extracted (e.g. a `welcome` step that classifies
  intent AND captures occasion/recipient/budget) were silently discarded before
  `onComplete` ran — making any routing that read those optionals impossible. The
  submit tool already accepts the full schema and the merge already stores all
  populated values; only the projection was lossy. It now projects all schema keys
  present in the collected data. Regression test in
  `test/core-grounding/extraction.test.ts`; full core suite 379/379, engagement
  107/107, hono-server 52/52.

## 0.3.3 — Collect grounding: one input per turn (no fabrication / no premature mutation)

Patch across the package graph (`0.3.2 → 0.3.3`). Completes the turn-by-turn flow
model so input-nodes never act on stale context.

### Fixed (`@kuralle-agents/core`)

- **`collect` nodes no longer fabricate fields from stale history.** A collect
  reached after the turn's input was already consumed by a prior node now
  **pauses** (presents its prompt, awaits the next turn) instead of running
  extraction over the whole transcript — which let a chatty model invent required
  fields (e.g. a sender name copied from the recipient). It now extracts only the
  current turn's fresh input.
- **The decide pause is now anchored to "input consumed this turn,"** not merely
  "no pending input" — so an interactive `decide` that IS the turn's first
  input-node still decides on that input (fixes a 0.3.2 edge where a withChoices
  decide as a flow's entry would wrongly pause).
- New ephemeral `RunContext.turnInputConsumed` tracks this per turn.

Net effect: a flow advances **one input-node per user turn**. Combined with
0.3.1/0.3.2, mutating steps (e.g. order creation) require an explicit
confirmation turn and fields are never inferred from old context. Regression
tests in `test/core-flow/runFlow.test.ts`; full core suite 378/378, engagement
107/107, hono-server 52/52.

## 0.3.2 — Interactive nodes wait for the user (no auto-advance)

Patch across the package graph (`0.3.1 → 0.3.2`). Stops a flow from racing
through interactive steps on ambient context.

### Fixed (`@kuralle-agents/core`)

- **An interactive `decide` (a `withChoices` node) now waits for the user's
  reply instead of auto-deciding from stale context.** Previously, when the flow
  cascaded into a choice node *without a fresh user turn*, `runFlow` immediately
  ran `runStructured` and picked from existing context — so one rich message
  could auto-pick a product, auto-confirm an order, etc. Now such a node returns
  `stay` (parking as `awaitingUser`) after its choices are presented; it only
  decides once the user actually replies. A plain `decide` with no choices is a
  pure branch and still runs. Regression test in `test/core-flow/runFlow.test.ts`.

This complements 0.3.1 (which fixed the *resume* side). Together: interactive
flows are now strictly turn-by-turn — present choices, wait, then act — so
mutating steps (e.g. order creation) require an explicit confirmation turn.

## 0.3.1 — Multi-turn flow resume fix

Patch across the package graph (`0.3.0 → 0.3.1`). Fixes a bug that stalled any
multi-turn flow at the first interactive node when driven over a turn boundary
(e.g. a bare `runtime.run` per HTTP request, as in a web chat route).

### Fixed (`@kuralle-agents/core`)

- **`decide` nodes now consume pending user input on resume.** `runFlow`'s decide
  branch ran `driver.runStructured` over stale messages without consuming the
  buffered pending input (which `collect` already does via `awaitUser`). On
  resume the user's reply never reached `decide()`, so a paused `withChoices`
  step (cart review, order confirm, product pick) could not advance — the turn
  emitted only `done`. Decide resume now consumes pending input and appends it to
  the message history before the decision.
- **`TextDriver.runStructured` now honors `node.choices`.** It ignored the
  offered choices, so an unconstrained string schema let the model answer with
  free-form prose that `decide()` could not match. It now injects the valid
  choice ids and instructs the model to return exactly one.

Regression tests added at both seams (`test/core-flow/runFlow.test.ts`,
`test/core-channel/textdriver.test.ts`). Whole graph republished together because
internal deps pin exact versions at publish (`workspace:*` → exact), so a
core-only bump would install a duplicate `core`.

## 2.0.0 — The Conversational Harness (core-v2)

A from-first-principles rewrite of `@kuralle-agents/core`. **Breaking; no
compatibility layer.** v1 (graph-interpreter runtime, four agent types, two
flow engines, parallel voice authority) is deleted.

### Breaking changes

- **One agent primitive.** `defineAgent({...})` replaces `LLMAgentConfig` /
  `FlowAgentConfig` / `TriageAgentConfig` / `CompositeAgentConfig`. Behavior is
  derived from which fields you populate (`flows` / `routes` / `agents`), not a
  `type` discriminator. `prompt` → `instructions`; `canHandoffTo` → `handoffs`.
- **Flows are `flows: Flow[]`** of single-job nodes — `reply` / `collect` /
  `action` / `decide` — and transitions are **returned node references**, not a
  `transitions[]` edge table. The `FlowNodeConfig` god-object is gone.
- **One imperative runtime.** `createRuntime(...)` → `Runtime`; a `hostLoop` +
  `runFlow` interpret agents directly. `OrchestrationAuthority`, `RealtimeRuntime`,
  `FlowManager`, `FlowTraverser`, `ProcedureRunner`, and the 5-stage pipeline are
  removed.
- **Durable effect log.** Side effects run through `ctx.tool` / `ctx.approve` /
  `ctx.signal` and are recorded; resume replays effects for **exactly-once**
  semantics and durable human-in-the-loop pauses. Persisted session shape
  changed (`RunState` + `StepRecord[]`); v1 sessions are not resumable.
- **One channel seam.** `ChannelDriver` (`TextDriver` / `VoiceDriver`) — the same
  agent runs on text and provider-native realtime (Gemini Live / OpenAI / xAI)
  with an identical transition sequence.
- **Standard Schema** for `collect` / `decide` / `defineTool` (Zod still works).

### Removed

#### Runtime & orchestration (core-v2)

- Agent classes (`Agent`, `FlowAgent`, `TriageAgent`, `CompositeAgent`) — `defineAgent()` only.
- `FlowManager`, `FlowTraverser`, `FlowGraph`, `FlowGraphBuilder`, v1 `FlowNodeConfig` / `transitions[]` edge model.
- `OrchestrationAuthority`, `DefaultOrchestrationAuthority`, `RealtimeRuntime`, five-stage text pipeline.
- `CapabilityBuilder`; `ProcedureRunner`, `buildProcedureTool`, `runtime.runProcedure()`.
- LiveKit native-realtime *authority* path (`KuralleRealtimeAgentController`, `LiveKitRealtimeAdapter`, `ToolContextBuilder`, `TurnCompletionCoordinator`, `createVoiceSession({ mode: 'realtime' })`). LiveKit voice is cascaded-only; provider-native realtime (Gemini/OpenAI/xAI) lives in `@kuralle-agents/realtime-audio` (`VoiceEngine`).
- `Runtime.chat()`; `compressNow()`, `drainBackgroundCompactions()`, `shutdown()`, `getAutoResolutionRate()`; `abortTurn()` (use `abortSession()`); `runtime.sessionStore` getter (use `getSessionStore()`).
- v1 `HarnessHooks` on `HarnessConfig` (20+ hooks) — v2 `Hooks` has five: `onStart`, `onStreamPart`, `onEnd`, `onConversationEnd`, `onError`.
- Pack-era `LegacyHarnessConfig` and ~40 harness-only fields (`autoCompaction`, `keyFacts`, `safety`, `escalation`, `contextManager`, `sessionCache`, `streamCallback` / `callback`, `channels`, `outputRedaction`, `personaExperiment`, …); `HarnessConfig` is only `runtime/Runtime.ts`.

#### Packages & packs

- `@kuralle-agents/config` and `@kuralle-agents/builder` (JSONC `.kuralle/` packs, `loadAriaflowConfig`, `createRuntimeFromConfig`, builder CLI).
- JSONC pack agents with a `type` field — export a `defineAgent()` `AgentConfig`.

#### Group A — dead v2-unwired code (`cleanup A`)

- `Flow.hybrid` and `FlowDetourRules` (hybrid off-flow detour mode).
- Per-agent `AgentConfig` fields: `escalation`, `extraction`, `persona`, `hooks`, `telemetry`; `types/escalationPolicy.ts`, `types/extraction.ts`.
- `HarnessConfig.safety` and entire `safety/` module: `RegexPiiModerator`, `JailbreakEchoModerator`, `LlamaGuardModerator`, `createDefaultOutputModerators`, `SafetyConfig`, `OutputModerator`.
- `autoCompaction`, `harnessNormalize`, `CompactionScheduler`, `KeyFactsExtractor`, and related compaction/facts config types.
- `ConfidenceRefinement`, `buildEscalateToHumanTool`, `EscalationConfig`, `EscalateToHumanToolResult` (session types `EscalationReason` / `EscalationOutcome` remain where needed).
- `defineProcedure`, procedure types, `ProcedureTool` / `buildProcedureTool` — use `defineAgent` flows + `ctx.tool`.
- `InjectionQueue`, `createInjectionQueue`, `commonInjections`, `policyProfiles`, `getPolicyProfileInjections`.
- `ContextManager`, `createContextManager`, `createSummarizingContextManager`.
- `SessionCache`, `SuggestionManager`, `StreamEmitter`.
- `createHttpCallback`, `createStreamCallbackAdapter`, and stream sinks (`createConsoleStreamSink`, `createFileStreamSink`, `createHttpStreamSink`, `createFunctionStreamSink`).
- `AuditCollector` class (`filterAuditEntries` remains for `replayAuditLog()`).
- `AutoResolutionRateResult`, `runtime.getAutoResolutionRate()`, and `OutcomeBreakdown`.

## Unreleased — agentic-conversation program (RFC-01..RFC-09)

Ships the agentic-conversation program: three-phase pipeline,
confidence-based escalation, output safety chain, procedures,
conversation outcomes, RAG citations, multi-channel continuity,
first-class persona, and the audit log.

### Breaking changes

- **`safety.outputModerators` now defaults to
  `[RegexPiiModerator, JailbreakEchoModerator]`** (RFC-03). Previously
  no moderators ran by default. If you depend on raw, unmodified model
  output (e.g. streaming-timing or token-budget tests, low-latency
  voice paths), opt out explicitly:
  ```ts
  createRuntime({..., safety: { outputModerators: [] } });
  ```
  The two default moderators run in parallel under a 150 ms deadline
  per moderator. `RegexPiiModerator` redacts (`rewrite` path) — it
  never blocks. `JailbreakEchoModerator` blocks only when the user
  message matched a known injection pattern AND the model output
  echoes a sensitive pattern.

- **`KnowledgeChunk.sourceId` is now required** (RFC-06). Existing
  retrievers that don't populate `sourceId` get auto-synthesized IDs
  with a `synthetic-<sha256-prefix>` form (operators can spot
  un-migrated sources by this prefix). Migration: add a stable
  `sourceId: '<your-source-id>'` to every chunk your retriever
  returns.

- **`Session` now carries `conversationId` and `channelId`** (RFC-07).
  Backward-compat default: when no `channels.conversationStore` is
  configured, `conversationId === sessionId` (1:1) and `channelId`
  defaults to `'web'`. Existing single-channel deployments need no
  changes. To opt into multi-channel continuity, configure
  `channels.conversationStore` and pass `channelId` at the request
  edge (or let the OpenAI-compat router infer it from Vapi /
  ElevenLabs metadata).

### New default behaviors (opt-out available)

- Citation rendering defaults to `'footnotes'` when a retriever is
  configured (RFC-06). Voice / SMS channels override to `'off'` via
  their channel policy.
- `ChannelPolicy` runs AFTER the validation chain and strips
  markdown / emojis / truncates per channel (`sms` / `voice` defaults
  enabled; `web` / `email` are no-ops). Override via
  `channels.policies`.

### Opt-in features (default off)

- `escalation` — confidence-based escalation + `escalate_to_human`
  auto-tool (RFC-02). Off until `escalation.enabled: true`.
- `audit` — per-event audit log subscriber + Hono `GET
  /api/sessions/:id/audit` endpoint (RFC-09). Off until
  `audit.enabled: true`.
- `outcomes.autoAbandonAfterMs` — background sweeper that marks
  inactive sessions `'abandoned'` (RFC-05). Off unless explicitly
  configured.
- `personaExperiment` — 2-arm A/B test over `BuiltinPersonas`
  (RFC-08). Off unless configured; cohort is pinned to the session
  via `metadata.personaExperiment`.

### Bug fixes / hygiene

- `markOutcome` for terminal outcomes (`resolved` / `escalated` /
  `abandoned`) now calls `conversationStore.closeConversation()` when
  configured, so the user's next message starts a fresh conversation
  instead of re-entering the closed thread within `windowMs`.
- `@kuralle-agents/postgres-store` gains a `prebuild` clean step that
  removes stale compiled test artifacts from `dist/`.
