# `tools` vs `effectTools` vs `globalTools` — why three tool fields, and should kuralle keep them?

**Date:** 2026-06-07 · **Author:** research workflow (grounded source read of `packages/kuralle-core` + AI SDK / OpenAI Agents / Pi / Mastra / cloudflare-agents prior art + Temporal/Inngest/Restate durability canon)
**Question:** `AgentConfig` (`packages/kuralle-core/src/types/agentConfig.ts:26-33`) carries three tool-ish fields — `tools?: ToolSet` (raw AI SDK), `effectTools?: Record<string, AnyTool>`, `globalTools?: Record<string, AnyTool>`. Is this an essential design or accidental sprawl? Keep, unify, or restructure?

All kuralle claims are `file:line`-verified against `packages/kuralle-core/src` (paths below are relative to that root). External claims cite a doc URL. Where my source read **corrects** the upstream reader findings, it is flagged inline.

---

## 1. TL;DR + verdict

The two surfaces a tool can occupy are **model-VISIBLE** (sent to `streamText` as the `tools` arg — schema only; the model decides to *call* it) and **EXECUTED** (the body that actually runs). kuralle deliberately decouples them: `defineTool`→`buildToolSet` strips `execute` via `toolToAiSdk` (`tools/effect/defineTool.ts:49-63`) so the model never gets an executor, and the runtime drives execution itself through the durable `ctx.tool(...)` journal (`runtime/ctx.ts:190-219`) — giving **exactly-once-on-replay** that neither the AI SDK nor the OpenAI Agents SDK ships natively. `effectTools` and `globalTools` are the **same durable primitive** (`defineTool`, both registered into the one executor at `runtime/Runtime.ts:118-125`); they differ only in *model visibility/safety policy* — `globalTools` is an ADR-0001 allow-list made visible in every speaking turn, `effectTools` is flow-gated — not in durability. Raw `AgentConfig.tools` is the odd one out and the genuine footgun: it carries its own `execute` that the **AI SDK auto-runs inside `streamText`, bypassing the journal entirely**, and it only applies on the off-flow host reply node.

**Verdict: `rename-or-restructure`.** Keep the durable primitive and the model-visible/executed split — that is essential and net-new versus every peer. But the three *fields* do not cleanly map to three *concepts*: `effectTools`+`globalTools` are one durable concept split by a visibility flag, and `tools` is a non-durable escape hatch that silently defeats the framework's headline guarantee. Restructure so the durable path is the default and the un-journaled raw-AI-SDK path is either eliminated or explicitly, loudly opt-in.

---

## 2. What each field actually is

### The two surfaces, defined

- **Model-VISIBLE surface** = the `tools` argument of `streamText` (`runtime/channels/TextDriver.ts:69-75`). Schema only; the model emits a tool *call*.
- **EXECUTED surface** = the registry that runs the body: `CoreToolExecutor` (`tools/effect/ToolExecutor.ts:35,61`), reached through the durable wrapper `ctx.tool(...)` (`runtime/ctx.ts:190-219`).

`buildToolSet` produces a schema-only `ToolSet` (`toolToAiSdk` returns a spec with no `execute`, `defineTool.ts:49-63`) and stashes the real executors in a `WeakMap` keyed by that set (`rawToolsBySet`, `defineTool.ts:70-87`) so a flow node recovers them (`rawToolsFromSet`, `flow/nodeBuilders.ts:61`) without separate registration. **What the `toolToAiSdk` strip accomplishes:** it makes the model-visible tool a pure *declaration* (name + description + input schema), so the AI SDK cannot auto-run it; execution is forced through kuralle's loop and the durable journal. That strip is the load-bearing seam — it is how kuralle turns the AI SDK's "tool with execute" into "tool-declaration only, executor held back for the runtime."

### Field-by-field (with the exact execution path)

**`AgentConfig.tools?: ToolSet`** (raw AI SDK `ToolSet`, `agentConfig.ts:26`)
- Used **only** on the off-flow / free-conversation host reply node: `buildAgentReplyNode` copies it verbatim onto `node.tools` (`runtime/agentReply.ts:14`); free conversation runs only if the agent has free-conversation capability **or** `agent.tools` exists (`runtime/hostLoop.ts:119`).
- Path: `agentReply.ts:14` → `resolveReplyNode` builds `resolved.tools = node.tools` (`nodeBuilders.ts:39-47,54`) → `TextDriver.resolveTools` seeds `aiTools = { ...resolved.tools }` (`TextDriver.ts:198`) → `streamText({ tools: aiTools })` (`TextDriver.ts:69-75`). These entries **still carry their `execute`** — they were never run through `toolToAiSdk`.
- **Not durable, and worse — double-dispatched.** It is not registered into the executor (Runtime merges only `config.tools`/`effectTools`/`globalTools`, `Runtime.ts:118-125`), so when kuralle's own loop reads `result.toolCalls` and calls `ctx.tool(name,...)` (`TextDriver.ts:97-110` → `executeModelTool.ts:27`), the registry lookup misses and `CoreToolExecutor` throws `Unknown tool` (`ToolExecutor.ts:89-91`) — unless the AI SDK already auto-ran the carried `execute` first (it does; see §4). Net effect of a raw `agent.tools`-with-`execute`: the AI SDK runs it un-journaled inside `streamText`, and kuralle's durable layer never sees it. This is the footgun.

**`AgentConfig.effectTools?: Record<string, AnyTool>`** (`agentConfig.ts:27`)
- Registered into the EXECUTED surface: merged into the one `CoreToolExecutor` at `Runtime.ts:118-128`.
- **Not automatically model-visible** — it becomes visible only when a flow node builds it into the node `ToolSet` (`buildNodeTools`/`buildToolSet`, `nodeBuilders.ts:39-46,84`; or recovered via `rawToolsFromSet`, `nodeBuilders.ts:61`). So: durable executor registry, visibility flow-gated. This is the Temporal-Activity analogue.
- Path when the model calls it: visible via a node → `streamText` → `result.toolCalls` → `executeModelToolCall` (`executeModelTool.ts:20-41`) → `ctx.tool` (`ctx.ts:190-219`) → `replayOrExecute` (exactly-once) → `CoreToolExecutor.execute` (`ToolExecutor.ts:61`). Also callable directly from flow `action` code via `ctx.tool`.

**`AgentConfig.globalTools?: Record<string, AnyTool>`** (`agentConfig.ts:28-33`)
- **Both surfaces.** Registered as executors (`Runtime.ts:124`) **and** made model-visible in every *speaking* turn: `TextDriver.resolveTools` merges `ctx.globalTools` into the node toolset (`TextDriver.ts:191-197`), threaded via `runCtx.globalTools = opened.agent.globalTools` (`Runtime.ts:176`).
- **Excluded from silent `collect` extraction:** the extraction turn's toolset is the submit tool only (`resolveExtractionTools`, `extractionTurn.ts:85-96`), which never reads `ctx.globalTools`.
- Same durable `ctx.tool` execution path as `effectTools`.

**Correction to the upstream reader:** the reader described `effectTools` and `globalTools` registration via `Runtime.ts:118-125` correctly, but in describing the raw-tools path it sometimes wrote `config.tools` as if it were the per-agent raw `ToolSet`. They are different: `Runtime.ts:119` merges `HarnessConfig.tools?: Record<string, AnyTool>` (`Runtime.ts:51`) — **runtime-level effect tools, which ARE registered and durable** — whereas `AgentConfig.tools?: ToolSet` (`agentConfig.ts:26`) is the per-agent raw AI SDK set that is NOT registered. The footgun is specifically `AgentConfig.tools`, not `HarnessConfig.tools`.

---

## 3. The mapping table

One row per *concept*. "Declaration" = model-visible schema; "Execution" = where the body runs; "Exactly-once" = does a retry/replay re-run the side effect; "Always-on safe tools" = a curated set visible everywhere the agent speaks.

| Concept | kuralle | AI SDK (`ai`) | OpenAI Agents SDK | Pi | Mastra | Temporal / durable canon |
|---|---|---|---|---|---|---|
| **Declaration (model-visible schema)** | `tools` (raw) on host node + schema-only set from `defineTool`→`buildToolSet`, `execute` stripped (`defineTool.ts:49-63`) | `tool({inputSchema})`; `execute` **optional** — native declaration/execution split [1] | `tool({parameters,execute})`; `execute` present in every example [3] | `ToolDefinition` 1:1 wrapped by `wrapToolDefinition` (one concept) | `createTool({...})` → one `Tool`, single `execute` | "Activity/Step interface" — workflow sees a stub, runtime supplies the result |
| **Execution (body runs)** | runtime-driven via `ctx.tool`→`CoreToolExecutor` (`ctx.ts:209`, `ToolExecutor.ts:61`) | in-process `execute`, or you run it yourself when omitted [1] | built-in agent loop runs `execute` [3] | `execute` runs inline in `runAgentLoop` | `tool.execute` runs in the agentic step | Activity runs once, outside the replay path |
| **Exactly-once on retry/replay** | **Yes** — `replayOrExecute` returns recorded `StepRecord.result` (`ctx.ts:97-131`), keyed by `toolEffectKey` (`idempotency.ts:17-24`) | **No** — plain async fn; retried turn re-runs it [2] | **No** natively — durability is the *external* Temporal integration [5] | **No** — grep for `idempot/exactly-once/effect-log` in tools/harness = 0 hits | **No** — `idempotentHint` is an MCP *advisory* annotation, not enforced; suspend/resume ≠ exactly-once | **Yes** — recorded result returned on replay (Temporal Side Effect [6], Inngest `step.run` [7], Restate `ctx.run` [8]) |
| **Always-on safe tools** | `globalTools` — visible every speaking turn, excluded from extraction; allow-list, never mutating (ADR 0001 `0001:23-25`) | not a concept (caller assembles `tools` per call) | not a first-class field | not a concept | not a first-class field | n/a (orthogonal to durability) |
| **Durable pause / human approval** | `needsApproval` + `ctx.signal` → `SuspendError`, resumed via `recordSignalDelivery` (`ctx.ts:152-168,199-205`; `replay.ts:13-53`) | none | `needsApproval: true` interrupt [4] | none | workflow suspend/resume (pause, not exactly-once) | Temporal signals / Inngest `waitForEvent` |

**Reader caveat verified:** the upstream reader flagged "I did not re-read `defineTool.ts` / confirm the executor enforces effect-log dedup." I re-read both. Confirmed: the dedup lives in `ctx.ts:97-131` (`replayOrExecute` + `findStepByKey`), keyed by `idempotency.ts:17-24`; `CoreToolExecutor` itself (`ToolExecutor.ts`) does *not* dedup — it only validates/serializes/times-out. The exactly-once property is real and lives in `ctx.ts`, exactly as the durability-canon mapping claims.

---

## 4. Why you can't "just have `tools`"

### The durability argument (when replay actually fires in kuralle)

A retry/replay re-enters a run whose effect log is non-empty; every prior `ctx.tool` call short-circuits to its recorded result instead of re-running (`ctx.ts:103-108`). This is not theoretical — it is the designed path for:

- **Durable pause/resume** — `needsApproval` tools and `ctx.signal(...)` suspend as a pause effect (`ctx.ts:152-168,199-205`); on resume every prior tool/clock effect replays from the log so the post-pause tool runs exactly once (`replay.ts:13-53`).
- **Crash/retry** — a turn that dies after recording some effects replays the recorded ones and executes only the unrecorded tail (`ctx.ts:111-114`). Caveat per `ctx.ts:194-197`: the *agent turn itself* is not a replayable effect for model-issued calls; exactly-once is guaranteed per recorded effect key, fully deterministic for flow `action` tools.
- **Voice / Cloudflare Durable Objects** — same `ctx.ts` path, no special-casing. Durability is whatever `SessionStore` backs (Memory/Redis/Postgres), so it survives DO eviction or process restart as long as the session persists.

A raw `AgentConfig.tools` entry with an inline `execute` **defeats all of this**. The AI SDK auto-runs a tool that has `execute` *inside the `streamText` step* — confirmed against AI SDK docs: tools "with execute function" are run by the SDK and their result fed back; `stopWhen` only governs whether it loops for a follow-up *model* call, not whether a tool with `execute` runs [1][9]. So kuralle's `streamText({ tools: aiTools })` (`TextDriver.ts:69-75`) auto-executes a raw `agent.tools` body before kuralle's loop ever reaches `ctx.tool` — un-journaled, re-run on every replay/retry. This is precisely the LangGraph hazard (durable *state*, side-effectful nodes re-execute on resume [10]) reproduced inside kuralle by an escape hatch.

This is the irreducible reason "just `tools`" is insufficient *for the durable framework*: a single async `execute` field cannot be both model-auto-run and runtime-journaled. kuralle's strip-and-hold-back machinery (`toolToAiSdk` + `rawToolsBySet`) exists specifically to keep the executor out of the model layer so the journal owns it.

### The honest counter-argument: could it collapse to ONE field?

Yes — and worth weighing seriously. The AI SDK's `execute` is **natively optional** ([1]: *"It is optional because you might want to forward tool calls to the client or to a queue instead of executing them in the same process"*). kuralle re-implements that optionality by hand (the `toolToAiSdk` strip + `WeakMap` recovery dance). A leaner design: **one field, durable-by-default**, where:

1. Every tool is a `defineTool` (already the durable primitive), executed via `ctx.tool` — exactly-once everywhere.
2. Model visibility is a per-tool/per-node property (`flow-gated` vs `global`), not a separate top-level field. `globalTools` collapses into a `visibility: 'global'` flag (or an `exposeEverywhere` set) on the one tool map — because `globalTools` is already *the same executor*, differing only by ADR-0001 visibility policy (`Runtime.ts:118-125`, ADR `0001:23-25`).
3. Raw AI SDK interop is preserved by an **explicit adapter** — wrap a third-party `tool({execute})` so its `execute` is *captured and routed through `ctx.tool`* (journaled) rather than left for the AI SDK to auto-run. This is the only way to keep interop AND durability; leaving raw tools to auto-execute is the bug.

What the counter-argument concedes: the three-field surface mostly *re-creates the AI SDK's own native split* (`tools` ≈ "tool I let the SDK run", `effectTools` ≈ "schema-only, I run it"). That part is arguably accidental — the SDK already gives it for free via optional `execute`. The part that is **essential and must survive any collapse** is the durable journal (`ctx.ts`) and the ADR-0001 *visibility/safety* distinction. A unify-to-one design is viable *only if* it preserves (a) exactly-once via `ctx.tool`, (b) the never-mutating-tools-everywhere safety invariant, and (c) a journaling interop adapter for raw AI SDK tools. If those three hold, one field is cleaner.

Why I still land on `rename-or-restructure` rather than `unify-to-one`: a single field forces visibility to become a per-entry property, which is a real ergonomic and migration cost, and the `globalTools` JSDoc safety warning (`agentConfig.ts:28-33`) is doing load-bearing pedagogy that a flag erases. The decisive, low-cost win is **eliminating the un-journaled raw path**, not collapsing the durable fields.

---

## 5. Recommendation

**Verdict: `rename-or-restructure`.** Keep `effectTools` and `globalTools` (they are one durable primitive split by an intentional, well-documented safety/visibility policy — ADR 0001). The defect is `AgentConfig.tools`: it is the only non-durable surface and it silently bypasses the framework's headline guarantee. Concrete changes, smallest-blast-radius first:

1. **Route raw `agent.tools` through the journal instead of `streamText` auto-exec.** In `runtime/agentReply.ts:14`, do not pass raw `agent.tools` straight onto `node.tools`. Instead strip their `execute` via `toolToAiSdk` (so the SDK cannot auto-run them) and register the captured executors into `CoreToolExecutor` alongside `effectTools` (`runtime/Runtime.ts:118-125`). Result: a host-reply tool call then flows through `executeModelTool.ts:27` → `ctx.tool` → `replayOrExecute` like every other tool — durable, exactly-once, no double-dispatch. This is the surgical fix and it removes the footgun without removing the field.

2. **Then decide the field shape.** Two coherent end states:
   - **Restructure (recommended):** rename `effectTools` → `tools` (the durable primitive becomes *the* tool field; it already accepts `defineTool` outputs), keep `globalTools` as the visibility/safety allow-list, and **delete the raw `ToolSet` field** — third-party AI SDK tools enter through a named adapter `wrapAiSdkTool(t)` that captures `execute` for `ctx.tool`. Migration: existing `effectTools:` → `tools:`; existing raw `tools: ToolSet` → wrap each entry. `globalTools` unchanged.
   - **Unify-to-one (leaner, costlier migration):** single `tools` map, per-tool `{ visibility?: 'flow' | 'global' }`; `globalTools` collapses into `visibility:'global'`. Preserve the ADR-0001 invariant as a runtime assertion (reject a `needsApproval`/mutating tool marked `global`).

3. **Guardrail the interop seam regardless of which shape ships.** A `defineTool` executor must never reach the model layer with its `execute` intact. Add a build/test guard (sibling to the repo's existing `scripts/check-no-stale-text-delta.sh` pattern noted in MEMORY) asserting that everything in a node's `streamText({tools})` is `execute`-free — i.e. the model layer only ever sees `toolToAiSdk` output. That makes "raw execute reaches the SDK" a CI failure, not a silent durability hole.

4. **Document the footgun now**, even before the refactor lands: update `agentConfig.ts:26`'s (currently absent) JSDoc on `tools` to state that raw AI SDK tools are **non-durable and off-flow-only**, mirroring the existing `globalTools` safety note (`agentConfig.ts:28-33`).

**Workers portability (verify before shipping the adapter):** the journal keying uses `node:crypto` `createHash('sha256')` (`runtime/durable/idempotency.ts:1,19`) and `randomUUID()` (`runtime/ctx.ts:1,63`). On Cloudflare Workers these require the `nodejs_compat` flag, or should fall back to WebCrypto `crypto.subtle.digest('SHA-256', …)` (async) / `crypto.randomUUID()` to keep the durable layer portable — `@kuralle-agents/cf-agent` targets Workers/DO, so this is a real seam. The rest of the journal (`replayOrExecute`, `StepRecord`, `RunStore`) is plain TS over a `SessionStore` and is Workers-clean.

---

## 6. Risks / non-goals

- **Behavior change risk (item 1):** routing raw `agent.tools` through the journal changes execution semantics for any app relying on the AI SDK auto-running an inline `execute` (e.g. a tool whose `execute` returns conversational text). Per the project rule "tools return data only," such usage is already off-pattern, but it must be called out in the changelog as breaking.
- **Migration cost (item 2 unify path):** collapsing `globalTools` into a per-tool flag touches every agent that declares global tools and erases the JSDoc safety pedagogy — hence not the recommended path.
- **Non-goal — don't reach for an external durability engine.** The durable journal already exists in-tree (`ctx.ts`); the peers that lack it bolt on Temporal [5]. kuralle should *keep* its native journal, not delegate to a workflow engine.
- **Non-goal — don't add a fourth tool field.** The whole finding is that the surface is too wide already; any new capability (interop, visibility) should be an attribute of the one durable primitive, not a new top-level field.
- **Out of scope:** voice-specific tool paths (`runtime/channels/VoiceDriver.ts`) were spot-checked to share `resolveMaxSteps`/extraction with text but not exhaustively traced; the recommendation assumes the text path is representative (the durable `ctx.tool` mechanism is driver-agnostic per `ctx.ts`).

---

## Sources

**kuralle (read directly):** `types/agentConfig.ts:26-33`; `tools/effect/defineTool.ts:49-87`; `runtime/ctx.ts:97-131,152-168,190-219,233-242`; `runtime/durable/idempotency.ts:17-24`; `runtime/durable/replay.ts:5-53`; `runtime/Runtime.ts:41-54,118-128,176`; `runtime/agentReply.ts:14`; `runtime/hostLoop.ts:119`; `runtime/channels/TextDriver.ts:60-110,191-229`; `runtime/channels/executeModelTool.ts:20-41`; `runtime/channels/extractionTurn.ts:85-96`; `flow/nodeBuilders.ts:39-87`; `tools/effect/ToolExecutor.ts:35,61,84-91`; `docs/adr/0001-agent-base-layer-in-every-node.md:8-39`.

**External:**
[1] AI SDK — Tools and Tool Calling (optional `execute`, declaration/execution split): https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
[2] AI SDK — no native durability/exactly-once (same page; responsibility on the developer).
[3] OpenAI Agents SDK — built-in agent loop runs `execute`: https://openai.github.io/openai-agents-js/
[4] OpenAI Agents SDK — `needsApproval` human-in-the-loop interrupt: https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
[5] OpenAI Agents SDK durability is an external Temporal integration: https://temporal.io/blog/announcing-openai-agents-sdk-integration ; AI SDK equivalent: https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel
[6] Temporal — Side Effects return recorded result on replay: https://docs.temporal.io/develop/go/side-effects ; Workflow determinism/replay: https://docs.temporal.io/workflow-definition
[7] Inngest — `step.run` result is saved and not re-run on retry: https://www.inngest.com/docs/learn/how-functions-are-executed
[8] Restate — `ctx.run` journaled, exactly-once without app-level idempotency keys: https://www.spheron.network/blog/ai-agent-workflow-orchestration-temporal-inngest-restate-gpu-cloud/
[9] AI SDK — `stopWhen`/`isStepCount` governs multi-step *model* looping, not whether a tool with `execute` runs (Context7 `/vercel/ai`, chatbot-tool-usage + rag-chatbot guides, retrieved 2026-06-07).
[10] LangGraph — durable *state*, side-effectful nodes re-execute on resume (the counter-example): https://docs.langchain.com/oss/python/langgraph/interrupts ; https://blog.raed.dev/posts/langgraph-hitl

**Peer-framework prior art (per upstream reader, spot-confirmed against the durability canon, not re-read here):** Pi `wrapToolDefinition` (one concept, no journal); Mastra `createTool` + `idempotentHint` (MCP advisory) + suspend/resume; cloudflare-agents plain AI SDK `tool()` + DO state/`schedule()` dedup/sub-agent re-attach (general tools re-run on recovery).
