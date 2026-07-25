# Agentic Voice AI Framework — Gaps to Close (agent layer)

**Date:** 2026-07-11 · **Scope:** `packages/core/src` **agent substrate only** — the speech/transcription/audio-latency layers are deliberately excluded (voice is wrapped on top of Kuralle agents, so the agent core is what must hold). **Companion:** `docs/kuralle-core-teardown.md` (F1–F9); this doc reuses its `file:line` discipline and cross-references its findings where they overlap.

**Method:** adversarial code-review against an external rubric — the six "Solution Framework" components of an agentic voice AI framework, plus its worked "insurance renewal" scenario. Every load-bearing claim is `file:line`-verified first-hand and corroborated by five parallel subsystem audits (orchestration, persistent context, mid-call tools, degradation/handoff, self-correction). Docs and comments were not trusted.

**The rubric being graded against** (agent-relevant parts):
1. **Multi-agent orchestration** — compose specialized agents; recognize a mid-call pivot and route without restarting.
2. **Persistent context** — running state of what was said, what was retrieved, and *the caller's underlying goal*.
3. **Real tool use mid-conversation** — call APIs/DBs mid-call, fold the result into the next utterance.
4. **Latency management (agent slice)** — **parallelize tool calls**; stream partials.
5. **Graceful degradation** — recognize competence boundary; hand off with **full context** to a human.
6. **Within-call self-correction** — notice the caller repeating/correcting themselves; adjust without restarting.

**The worked scenario:** caller asks *"why did my premium go up?"* → pivots to *"add a driver"* → pivots to *"bundle home insurance"* → may circle back to the premium question; on handoff the human gets *"a full summary of everything already resolved."*

---

## 0. Verdict and scorecard

Kuralle's agent core **clears the bar a "chatbot-with-voice" fails** — it has real flows-as-SOP, durable session state, structural (not prompt-flagged) routing, genuine mid-flow tool use, and a real human-handoff brief. But measured against the rubric's *own worked example*, the agent layer **breaks at the second nested pivot**, **risks serving stale data** on repeated lookups, has **no structured goal/thread memory**, and treats **self-correction as an emergent LLM property rather than a mechanism**. Two advertised primitives are shipped-but-unreachable dead code.

| # | Rubric component | Verdict | Grade | Gaps |
|---|------------------|---------|-------|------|
| 1 | Multi-agent orchestration | Substrate real, but **handoff is a chimera** (§0.1); multi-pivot single-depth; routing is context-blind | **C+** | G1–G4, G16, G17 |
| 2 | Persistent context | Bytes durable; *cognition* (goal/thread) absent; retention cache dead; **tool results not in next-turn history** | **C−** | G5–G7, G18 |
| 3 | Mid-conversation tool use | Works mid-flow; cross-turn exactly-once **broken** | **B−** | G8 (= teardown F6) |
| 4 | Parallelize tool calls | **Absent**; the durable log structurally forbids concurrency | **D** | G9 |
| 5 | Graceful degradation → human | Brief real but scoped/opt-in; competence detection not built-in; filter API dead; **model summary dropped** | **C** | G10–G12, G16 |
| 6 | Within-call self-correction | Largely unimplemented (~3/16 Rasa repair patterns); natural correction path silently broken | **D** | G13–G15 |

**Root cause, named (one sentence):** three of the six components are graded down by the *same class of defect* — a capability that is **defined but not wired** (`retrievalCache`, `handoffFilters.inputFilter`), **gated behind a default-off experimental flag** (`outOfBandControl` → pivot recognition), or **delegated wholly to the LLM re-reading raw history** (goal tracking, self-correction) rather than being a structural mechanism. The fixes below are mostly *wiring and scoping*, not new subsystems.

### §0.1 Corrections after cross-checking `docs/kuralle-core-teardown.md`

The first cut of this doc **over-graded Components 1 and 5** and **overstated context retention in Component 2**. Handoffs are the mechanism both orchestration and human-escalation rest on, and the teardown (§5–§6) shows a *single* handoff is more broken than "depth-2, one-way" implied:

- **Handoff chimera (new G16, teardown §6):** persona (`baseInstructions`), `controlModel`, enforcer/limits/processors, and the tool executor are **not** switched on handoff — and the target's registry-only tools throw `Unknown tool`. Composing specialists and clean escalation don't hold for any specialist with its own persona or tools. → Component 1 B→**C+**, Component 5 B−→**C**.
- **Mid-flow handoff crashes the target (new G17, teardown §6):** `run.activeFlow` stays set → target throws `Active flow not found`. Directly the insurance pivot-then-route path.
- **Free-conversation tool results absent from next-turn history (new G18, teardown §5):** retrieved data persists in the journal/event-log but **not** in the message history the model reads next turn — so circle-back to a lookup result fails regardless of window size. → Component 2 C→**C−**.
- **Sharpenings folded in below:** routing classifier is **context-blind** (sees only the latest user message — G2); handoff `summary` authored by the model is **dropped** (`classifyControl`) and cross-turn handoff ping-pong is **unbounded** (G4/G12); the authoritative repair-pattern bar is **Rasa CALM's 16 named patterns, of which Kuralle has ~3** (Component 6 root cause); `maxTurns` bricks the session and completed flows are one-shot (F7/F9) — both bite long multi-request calls (Part 4).

Not re-listed as new gaps because the teardown owns them as keystones: journal scoping (F4/F6/H3/H7 → G8), concurrency/CAS (§3), determinism defaults (§4). See its §9 ordering.

---

## Part 3 — Gaps by component

### Component 1 — Multi-agent orchestration

The orchestration *substrate* is genuine: shape is derived structurally (`deriveAgentShape`, `runtime/deriveAgent.ts:68-82`), the message thread survives a handoff without a call restart (`runtime/Runtime.ts:299-318`), and sub-agent composition is wired with a working example. But the *pivot* behavior the scenario demands is single-depth, the routing that recognizes a pivot is context-blind, and — the correction from the teardown — the handoff itself is a chimera (G16) that crashes mid-flow (G17).

| # | Gap | Severity | Evidence | Failure it causes |
|---|-----|----------|----------|-------------------|
| **G1** | **`__flowPark` is a single slot, not a stack.** When a caller mid-flow pivots to another flow, the current `{flow,node}` is parked so it can resume — but `setFlowPark` overwrites the one slot (`flow/collectDigression.ts:31-32`), and resume deletes it (`flow/runFlow.ts:311`). A→B→C nesting overwrites A's resume point. | **CRITICAL** (scenario-breaking) | `collectDigression.ts:31-32,93-102`; `runFlow.ts:308-320` | The exact 3-topic insurance call: after the second pivot ("bundle home"), the "add a driver" thread's resume position is lost. The caller never gets returned to it. |
| **G2** | **Pivot recognition is triple-gated, off by default, and context-blind.** `runCollectDigression` fires only when (a) `experimental.outOfBandControl` is on — **default false** (`types/agentConfig.ts:54-57`, `Runtime.ts:226`), (b) the active node is a `collect` node, and (c) extraction *did not advance* (`flow/collectUntilComplete.ts:95-108`). A pivot that fills a required field is swallowed as data; a pivot during a `reply`/`decide` node isn't caught here. **And the routing classifier that recognizes the pivot sees only the latest user message — no conversation context** (`runtime/select.ts:50`; teardown §4.7). | HIGH | `agentConfig.ts:54-57`; `collectUntilComplete.ts:92-108`; `select.ts:50` | Out of the box mid-flow pivots aren't recognized; even enabled, a context-dependent pivot ("and the home one too") routes blind. |
| **G3** | **Sub-agent composition is depth-2 capped.** Only top-level agents and their *direct* children are indexed as handoff targets (`Runtime.ts:644-653`); grandchildren are unreachable. | MEDIUM | `Runtime.ts:644-653`; `runtime/hostControlTools.ts:39-49` | A specialist tree deeper than one level (e.g. `policy → pricing → proration`) cannot be composed by routing. |
| **G4** | **Handoffs are one-way and loop-unbounded.** No automatic pop back to the router (`Runtime.ts:282-318`); each specialist must pre-declare `handoffs`/`routes` back. And `handoffCount` **resets every user turn** (`Runtime.ts:241`) while `handoffHistory` is written but **never read for loop suppression** — so A→B→A ping-pong at one hop per turn is unbounded (teardown §6). | MEDIUM | `Runtime.ts:241,282-318` | Multi-specialist calls require every specialist wired to every other; a missed wire strands the caller, and a routing oscillation loops indefinitely across turns. |
| **G16** | **The handoff target is a chimera** (teardown §6). On handoff the runtime swaps tools/knowledge/memory but **not** `baseInstructions` (persona, single write site `Runtime.ts:224`), `controlModel` (`:206`), enforcer/limits/processors (`:169`), or the `CoreToolExecutor` tool map (`:179-189`, `private readonly`, no registration API). The target's **registry-only tools** (`knowledge_search`, `workspace`, flow-action `ctx.tool` calls) throw `Unknown tool`. | **CRITICAL** | `Runtime.ts:169,206,224,299-317`; teardown §6 | The specialist speaks in the *source's* persona under the *source's* policies, and any tool it owns beyond global/working-memory tools fails. "Compose specialists" and "hand off cleanly" don't hold for a real specialist. |
| **G17** | **Mid-flow handoff crashes the target.** A handoff issued while `run.activeFlow` is set leaves it set; the receiving agent enters `runActiveFlow` and throws `Active flow not found` because the flow belongs to the source agent (`hostLoop.ts:57-62`, `runFlow.ts:216-217`). | HIGH | `hostLoop.ts:57-62`; `runFlow.ts:216-217`; teardown §6 | The insurance path — pivot mid-flow, then route to a specialist — throws instead of transferring. |

**Not a gap, but a mismatch to record:** the rubric's "reasoning agent that plans + tool-calling agent that executes" **decomposition does not exist** and should not be built to match the words. Kuralle's separation is `controlModel` (routing/decide/extract at temp 0) vs `model` (speaker) — `types/agentConfig.ts:29-32` — plus SOP-in-flows. That is a *different and arguably better* factoring; the gap is documentation/positioning, not code. **Closes when:** the framework's voice-positioning doc explicitly maps rubric-language → Kuralle primitives so integrators don't mis-map.

**Root cause for G1–G2:** the pivot machinery was built as a *digression* feature (answer an aside, resume one form) rather than a *topic-stack* feature (juggle N live intents). Closing G1 is the single highest-leverage orchestration fix.

**Fixes / definition-of-done:**
- **G1** — replace `__flowPark: FlowPark` with `__flowParkStack: FlowPark[]`; push on `switchFlow`, pop on flow `end` (`runFlow.ts:308-320`), guard against unbounded depth (cap + oldest-evict, mirror the event-log cap). *Closes when* a 3-flow nested-pivot test resumes A after C→B→A unwind. Effort: **S** (one data structure, two call sites, one test).
- **G2** — make `outOfBandControl` non-experimental and default-on for flow agents (this is also teardown §4.2), and extend digression detection to `reply` nodes, not just stalled `collect`. *Closes when* a pivot uttered during a reply node is recognized and parked. Effort: **M**.
- **G3/G4** — index the full agent tree recursively (`indexAgents`), add an opt-in "return to referrer" transition so a finished specialist pops back to the referrer, and read `handoffHistory` to suppress cross-turn ping-pong. Effort: **M**.
- **G16 (do this before demoing any multi-agent call)** — rebuild the *full* agent surface on handoff: persona/`baseInstructions`, `controlModel`, policies/enforcer/processors, and the executor's tool map from the target agent. Add a `CoreToolExecutor` registration API or rebuild it per active agent. *Closes when* a handoff to a specialist with its own persona + `knowledge_search` tool answers in-persona without `Unknown tool`. Effort: **M** (touches the handoff path and the executor's `private readonly` map). Cross-ref teardown §9.3.
- **G17** — clear `run.activeFlow`/`activeNode` when a handoff transition fires from inside a flow, so the target starts clean. *Closes when* a mid-flow handoff transfers instead of throwing. Effort: **S**.

### Component 2 — Persistent context

Storage is genuinely durable: the whole `Session` blob (messages, `workingMemory`, `state`, flow position via `durableRuns`) is serialized by Redis/Postgres/DO-SQLite backends. The gaps are that the *cognitive* claims — "what's been retrieved" and "the caller's underlying goal" — have no structured representation.

| # | Gap | Severity | Evidence | Failure it causes |
|---|-----|----------|----------|-------------------|
| **G5** | **No structured goal/intent/topic tracking.** No `goal`/`intent`/`topic`/`thread` field exists on `Session`, `RunContext`, or working memory (the only `goal` is a *test persona*, `eval/simulation.ts`). "The caller's underlying goal" is delegated entirely to the LLM re-reading raw history each turn. | HIGH | grep negative across `runtime/`; `types/session.ts:38-57` | Circle-back to "why did my premium go up" works only if those turns are still in the context window. There is no queryable "the premium thread" to reference on demand. |
| **G6** | **The session retrieval cache is dead code.** `RunContext.retrievalCache` and `KnowledgeProvider.createSessionCache()` are defined but never assigned or read anywhere in core; the documented owner "IntakeStage" **does not exist**. | HIGH | `types/session.ts:125-131`; `runtime/KnowledgeProvider.ts:75-79` (definition + comment only) | Retrieved external-system data (a policy/pricing lookup) is not retained in any semantic, queryable store — it survives only as raw `tool-result` messages subject to compaction. The one primitive designed to fix this is unreachable. |
| **G7** | **Compaction and circle-back are lossy.** Compaction truncates tool results to ~200 chars before a 250-word LLM summary (`runtime/compaction.ts:27-36`), which is itself opt-in (teardown §5). The flow-transition summarizer `reset_with_summary` is *lossier still* — it drops the last user message (`flow/contextStrategy.ts:69-71`), and degraded turns append a canned `SAFE_DEGRADED_MESSAGE` as if the model said it (`Runtime.ts:354-362`). | MEDIUM–HIGH | `compaction.ts:27-36`; `contextStrategy.ts:69-71`; `Runtime.ts:354-362` | On a long call a large policy/pricing result can be clipped; the premium thread survives compaction only if the summarizer judges it an "open question"; history can be fabricated or the last turn dropped. |
| **G18** | **In free conversation, tool results never enter the model's next-turn context** (teardown §5). Only the final `turn.text` is persisted to history (`runtime/hostLoop.ts:208-210`); tool calls/results live in the driver-local array and the journal. The event log (G6/G7) captures them durably but nothing feeds them back into the prompt. | HIGH | `hostLoop.ts:208-210`; teardown §5 | "What did that policy lookup return?" one turn later is unanswerable — retrieved data can't be referenced across turns *even if it's in the window*, because it isn't in `messages`. Directly defeats the circle-back and the "incorporate the result into what it says next" claim across a turn boundary. |

**Root cause:** the layer that would satisfy component 2's cognitive claims (a session-scoped, queryable retrieval + goal store) was *designed* (`retrievalCache`, `createSessionCache`) but never wired into the turn loop — so context persistence today means "durable bytes," not "durable understanding."

**Fixes / definition-of-done:**
- **G6 (do this first — it unblocks G5/G7)** — instantiate `createSessionCache()` once per session and populate it from `KnowledgeProvider`/tool retrievals; read it before re-fetching. *Closes when* a repeated lookup in the same session is served from the cache and appears in the handoff `state`. Effort: **M**. **Note:** this also mitigates G8's stale-replay blast radius by making retrieval intent explicit.
- **G5** — add a light `session.workingMemory.__goals: {topic, status, lastTurn}[]` updated by a cheap control-model pass (reuse the `controlModel`, temp 0), and expose it to reply nodes so circle-back can reference a *tracked* thread, not a re-read one. *Closes when* the premium thread is referenceable after it has scrolled out of the verbatim tail. Effort: **M–L**.
- **G7** — make compaction default-on for flow/voice agents and make the summarizer goal-aware (never drop a thread with an open `__goals` entry); retire or unify `reset_with_summary` (teardown §5); stop appending fabricated degraded-turn text to history. Effort: **S** on top of G5.
- **G18** — in free conversation, persist model-issued tool call/result parts into `run.messages` (as the flow path already does), so the next turn's prompt can see what the tools returned. *Closes when* "what did that lookup say?" is answerable on the following turn. Effort: **S–M**. **This is the cheapest single win for the circle-back scenario** — it makes retrieved data referable without any goal-tracking (G5) at all.

### Component 3 — Real tool use mid-conversation

Mid-*flow* tool use genuinely works: `globalTools` are model-visible in every speaking node (ADR 0001; `channels/TextDriver.ts:127`) and correctly excluded from silent extraction, and a tool result is folded into the same turn via the `maxSteps` re-invoke loop (`TextDriver.ts:110-162`). The gap is durability across turns.

| # | Gap | Severity | Evidence | Failure it causes |
|---|-----|----------|----------|-------------------|
| **G8** | **Cross-turn stale replay (= teardown F6).** `sessionDerivedRunId(sessionId){return sessionId}` (`runtime/openRun.ts:37-39`) → the durable step-log spans the *entire session*, while callsite ordinals reset every turn (`runtime/ctx.ts:199-201`). A new turn issuing the same tool + same args at the same ordinal hits the old key and `findStepByKey` **returns the cached result without executing** (`ctx.ts:105-111`). | **CRITICAL** | `openRun.ts:37-39`; `ctx.ts:99-133,199-201,220`; `durable/idempotency.ts:17-24` | The scenario's "pull policy + pricing for the renewal *and* the new-driver question": a second `getPolicy({id:X})` on a later turn returns turn-1's stale pricing. Any zero-arg/stable-arg tool ("get_balance") is frozen to its first-ever result. |

This gap is fully documented in the teardown (F6, with a reproducing harness at `test/audit-validation/6-*.test.ts`; the dual double-exec case is F4; execute-then-record is H1). It is repeated here because it is the single defect that most directly falsifies the rubric's component 3, and because closing it is a prerequisite for trusting components 2 (G6) and 5 (G11).

**Root cause (from teardown §2):** the journal has no notion of a *logical run boundary* — it is scoped to a never-ending session and keyed by source-position ordinals. **Fix / definition-of-done:** give the journal a real scope — rotate `runId` per turn (or include a turn-id in the effect key) *and* write intent-before-execute (H1). *Closes when* the F6 harness shows the second identical call re-executes and F4's double-exec no longer fires. Effort: **M**, but touches the durability spine — coordinate with the teardown's §2 fix, do not patch piecemeal.

### Component 4 — Parallelize tool calls (agent slice of latency management)

Streaming partials is real (the `text-start`/`text-delta`/`text-end` lifecycle, ADR 0004). The specific "parallelize tool calls" requirement is not met at the agent layer.

| # | Gap | Severity | Evidence | Failure it causes |
|---|-----|----------|----------|-------------------|
| **G9** | **No parallel tool execution — and the durable log forbids it.** Dispatch is a serial `for` loop (`channels/TextDriver.ts:115-161`); `CoreToolExecutor.parallelExecution` defaults `false` and forces a serial mutex when false (`tools/effect/ToolExecutor.ts:48,61-80`); and even if flipped, the journal's `index: steps.length` append + `SessionRunStore`'s `steps.length === record.index` invariant (`durable/SessionRunStore.ts:42-44`) race under concurrency. | MEDIUM (latency), HIGH (as a blocker) | `TextDriver.ts:115`; `ToolExecutor.ts:48,61-80`; `SessionRunStore.ts:42-44` | Two independent lookups the renewal answer needs (policy + pricing) run back-to-back instead of together — adding a full round-trip of latency on the exact turn the rubric budgets at ≤500–800ms. |

**Root cause:** the sequential-log durability model (component 3's mechanism) is structurally incompatible with the concurrency component 4 wants. These two requirements pull against each other and must be co-designed.

**Fix / definition-of-done:** make the journal concurrency-safe first (allocate ordinals eagerly and deterministically *before* awaiting, so N parallel effects reserve indices `k..k+N-1` in call order, then settle in any order), then let `ctx.tool` fan a batch of model-issued calls through `Promise.all` when none of them is `needsApproval`/mutating. *Closes when* two read-only tools in one model step run concurrently and the journal replays them deterministically on resume. Effort: **L** (must land after/with G8). **Cheaper interim:** parallelize only `replay:false` read tools (they already bypass the ordinal journal via the `steps.length`-suffixed audit key, `ctx.ts:232-254`), which removes the log-invariant blocker for the common "two independent reads" case. Effort: **M**.

### Component 5 — Graceful degradation → human handoff

The human-handoff brief is genuinely generated (`escalation/escalation.ts:56-104`, a real `SUMMARY_PROMPT`), delivery is wired and fails-open, and hand-back works (`resumeFromEscalation`, `Runtime.ts:604-637`). The gaps are that "full context," "recognize competence," and the agent-to-agent filter are each weaker than advertised.

| # | Gap | Severity | Evidence | Failure it causes |
|---|-----|----------|----------|-------------------|
| **G10** | **No built-in competence-boundary detector.** No confidence/frustration/no-progress classifier ships. Escalation fires only when the *model* calls a control tool, a *host-written* validator returns `escalate`, or a *flow author* hardcoded an escalate node. `low-confidence`/`frustration` (`escalation/types.ts:3`) are just labels the host must decide to attach. | HIGH | `escalation/types.ts:3`; `runtime/policies/agentTurn.ts:201-210`; teardown §4.6 (confidence gate inert by default) | "Recognize the boundary of its own competence" is 100% host-supplied. Out of the box the agent never *notices* it should escalate — it loops or hallucinates instead. |
| **G11** | **The brief is not "full."** The summarizer and the `recentMessages` payload see only the last **12** messages (`escalation/escalation.ts:60`); earlier resolutions survive only if in `state` or inferred. The brief can be `undefined` on summarizer error/empty tail (`:88-90`), and the whole path is opt-in — no `config.escalation` → `dispatchEscalation` returns immediately (`Runtime.ts:548-551`). | MEDIUM | `escalation.ts:60,74-90`; `Runtime.ts:548-551` | On a long insurance call, "a full summary of everything already resolved" is really a best-effort ≤120-word note over the last 12 turns — the human still starts partly cold, or with no brief at all. |
| **G12** | **`handoffFilters.inputFilter` is dead API, and the model's handoff `summary` is dropped.** `removeToolHistory`/`keepRecentMessages`/`composeFilters` are exported (`index.ts:234`) and `inputFilter?` is a config field (`types/processors.ts:77`), but `grep 'inputFilter('` → **zero call sites** — the full raw `runState.messages` transfers untouched (`Runtime.ts:282-318`). Separately, the `summary` the model authors on a handoff tool is discarded by `classifyControl` (`flow/classifyControl.ts:8-12`; teardown §6). | MEDIUM | `index.ts:234-244`; `types/processors.ts:77`; `Runtime.ts:282-318`; `classifyControl.ts:8-12` | Advertised context-management-on-handoff never runs (specialist gets the raw transcript, tool spam included), and the one summary the model *does* write is thrown away. |

**Root cause:** the escalation *plumbing* is well-built (typed request, fail-open delivery, hand-back), but the two ends the rubric cares about — *deciding* to escalate (G10) and *what the human receives* (G11) — are under-built relative to the plumbing, and the sibling agent-to-agent path (G12) was specified and never connected.

**Fixes / definition-of-done:**
- **G10** — ship a default competence detector: escalate on N consecutive no-progress turns (reuse the collect `advanced` signal), on repeated user frustration tokens (reuse `parseConfirmation`'s lexicon), or on a populated low-confidence signal. Make the confidence gate non-inert by default (teardown §4.6). *Closes when* an agent with no host validator still escalates on a stuck loop. Effort: **M**.
- **G11** — build the brief from a goal-aware source (G5's `__goals` + compaction summary) rather than a fixed 12-message tail, and emit a minimal transcript-derived brief even when the summarizer errors (never `undefined`). *Closes when* a resolution 20 turns back appears in the brief. Effort: **S–M** (rides on G5).
- **G12** — invoke `inputFilter` in the handoff path (`Runtime.ts:282-318`) with a sane default filter (`removeToolHistory` + `keepRecentMessages(N)`), or delete the API and the config field so it stops lying. *Closes when* a handoff to a specialist applies the configured filter (test asserts tool messages stripped). Effort: **S**.

### Component 6 — Within-call self-correction

This is the weakest component. There is no structural detection that a caller repeated themselves or corrected a detail; any apparent self-correction is the LLM re-reading history unaided, and the one mechanical correction path a flow author would naturally build is silently defeated.

| # | Gap | Severity | Evidence | Failure it causes |
|---|-----|----------|----------|-------------------|
| **G13** | **No repetition/correction detector.** Grep for repeat/re-ask/"already said"/misunderstanding finds only *agent-side* loop guards (`guards/`) and prompt copy telling the model not to repeat. Nothing compares consecutive user turns. | HIGH | grep negative; `guards/index.ts:8` (agent-side only) | The rubric's core ("notice a caller repeating themselves") has no implementation. The agent cannot tell that its last turn didn't land. |
| **G14** | **Slot correction is broken on the natural path.** Collected data is write-once: `reduceTransition` never clears `__collect_<id>`, there is no `resetCollect` anywhere, and on re-entry `schemaSatisfied` reads the stale value and immediately re-fires `onComplete` with old data (`flow/collectUntilComplete.ts:45-48`). The confirm gate classifies "no — I said Tuesday not Thursday" as *decline* and **discards the "Tuesday"** (`flow/runFlow.ts:114-122`). | HIGH | `collectUntilComplete.ts:45-48,91-96`; `runFlow.ts:114-122`; grep negative for `resetCollect` | The intuitive design (confirm "no" → back to collect) silently re-emits the *old* value; the caller's correction is never solicited or captured. Correcting a slot appears to work only when the model volunteers to re-submit an already-filled field. |
| **G15** | **Validation "self-correction" is a text swap, not a retry.** A validator `rewrite` substitutes judge-written text (`runtime/policies/agentTurn.ts:212-213`; `capabilities/validators/groundingValidator.ts`); the primary agent is never re-invoked. The confidence gate only branches/annotates (`flow/runFlow.ts:229-249`). Neither is triggered by "the caller corrected me." | MEDIUM | `agentTurn.ts:212-213`; `runFlow.ts:229-249` | There is no bounded retry-until-corrected loop; a grounding failure yields judge-authored text, not a re-generation, and it is orthogonal to the correction signal anyway. |

**Root cause:** correction was never modeled as a first-class event. The confirm gate captures *that* the caller declined but throws away *what* they wanted changed; collect slots have no reset; and validation repair is aimed at hallucination, not at "the caller corrected me." Self-correction is therefore entirely emergent. **The reference bar (teardown §8):** Rasa CALM ships **16 named, overridable repair patterns** (correction, clarification, interruption+resume, skip, cancel, silence, repeat, …); Kuralle implements ~**3 of 16**, unnamed and gated behind the experimental `outOfBandControl` flag. A related integrity hole: after `maxTurns` a collect node **force-completes with partial data**, bypassing `schemaSatisfied` (`flow/collectUntilComplete.ts:69-74`) — exactly the failure mode a correction loop should prevent.

**Fixes / definition-of-done:**
- **G14 (highest-leverage)** — on a confirm-decline that routes back to a collect node, clear that node's `__collect_<id>` and re-extract, *and* run extraction over the decline utterance so "no, Tuesday" updates the slot in one turn. *Closes when* a confirm-decline-with-correction test overwrites the slot without re-asking. Effort: **S–M**.
- **G13** — add a cheap turn-over-turn similarity/repetition signal (the caller repeated → surface a "you may not have been understood" reprompt or escalate hook). Reuse the `controlModel`. *Closes when* a repeated user utterance triggers a distinct reprompt path. Effort: **M**.
- **G15** — if grounding/confidence fails, offer a bounded *re-generation* of the primary turn (not only a judge text-swap) before falling back to the canned safe message. Effort: **M**.

---

## Part 4 — The insurance scenario, as an end-to-end failure trace

The rubric's own worked example is the sharpest test. Below is the literal call, step by step, with the gap that bites at each step. This is the artifact to demo-drive once the gaps are closed.

| Step | Caller says | What the rubric demands | Kuralle today | Gap | Stands? |
|------|-------------|-------------------------|---------------|-----|---------|
| 1 | "Why did my premium go up?" | Reason + pull data + answer | Reply turn + `globalTools` lookup, result folded in same turn (`TextDriver.ts:110-162`) | — | ✅ |
| 2 | "Actually, add a driver." | Recognize pivot, **hold thread 1** | `runCollectDigression` parks flow 1, switches to the driver flow — **only if `outOfBandControl` on, at a collect node, and the utterance doesn't fill a slot**. If the driver work is a *separate specialist agent* rather than a sibling flow, the mid-flow handoff **throws** (`Active flow not found`) and the specialist runs in the wrong persona/executor | G1, G2, **G16, G17** | ⚠️ conditional / ❌ if specialist |
| 3 | "And bundle my home insurance." | Recognize 2nd pivot, **still hold thread 1** | Parking the bundle flow **overwrites** the driver flow's single park slot; thread 1's resume point is **lost**. If "bundle" reuses a flow already completed this session, re-entry is **blocked** (F9, one-shot flows) | **G1**, F9 | ❌ |
| — | (agent pulls pricing for both topics) | Fresh, correct data per topic | If the same `getPolicy({id:X})` runs on two turns → **stale replay** returns turn-1 data | **G8** | ❌ risk |
| 4 | "Wait, go back to the premium thing." | Reference the earlier thread + its retrieved data | No structured thread; and in free conversation the earlier *tool results* were never written to history, so even in-window the model can't cite the earlier lookup | G5, G7, **G18** | ❌ for retrieved data / ⚠️ for prose |
| 5 | "No — the driver's a 2019, not 2016." | Correct a captured detail without restart | Confirm gate reads *decline*, discards "2019"; collect slot is write-once → re-fires stale value | **G14**, G13 | ❌ |
| 6 | (agent hands to a human) | **Full summary of everything resolved** | Best-effort ≤120-word brief over the **last 12 messages**; can be `undefined`; opt-in; a model-written handoff summary would be dropped | G11, G10, G12 | ⚠️ partial |

**Reading of the trace:** the call survives step 1 comfortably (Kuralle is well past "chatbot-with-voice" here), degrades at step 2 (non-default flag; **throws outright if the pivot targets a specialist agent mid-flow** — G17), **hard-fails at step 3** (single park slot — G1; blocked entirely if the flow was completed earlier — F9), **risks wrong pricing** on any repeated lookup (G8), **cannot cite its own earlier retrieved data** (G18), and cannot mechanically absorb the step-5 correction (G14). The step-6 handoff is real but not "full." The cheapest path to "completes with a real handoff" is **G17 + G1 + G18 + G14 + G8** — four of the five are **S** effort; only G8 touches the durability spine.

---

## Closing plan — dependency-ordered

The gaps are not independent; close them in this order so each lands on a stable base. **Tier 0 is the cheap, high-leverage set surfaced by the teardown cross-check — four of its five are `S` effort and together they carry the insurance trace.**

**Tier 0 — unblock the flagship scenario (mostly `S`):**
1. **G17 — clear `activeFlow` on mid-flow handoff** (**S**). Stops the outright crash when a pivot routes to a specialist.
2. **G16 — rebuild the full agent surface on handoff** (**M**). Without it, every specialist is a chimera; do it before any multi-agent demo. (= teardown §9.3.)
3. **G1 — park stack** (**S**, scenario-breaking, huge demo payoff).
4. **G18 — persist tool results to free-conversation history** (**S–M**). Cheapest win for circle-back to retrieved data.
5. **G14 — slot-correction reset + extract-over-decline** (**S–M**).

**Tier 1 — durability spine and defaults:**
6. **G8 / teardown F6 — scope the journal per-turn** (CRITICAL). Prerequisite for trusting G6/G11 and for G9. Do it *with* teardown §2, not as a patch.
7. **G12 — wire or delete `inputFilter` + stop dropping the model summary** (**S**). Stop shipping dead API.
8. **G2 — `outOfBandControl` default-on for flow agents; feed the classifier context; extend digression to reply nodes** (**M**; overlaps teardown §4). Also unblock F9 (reset `__completedFlows` on re-entry intent) so a second request in-session isn't blocked.

**Tier 2 — the cognitive layer:**
9. **G6 — wire `createSessionCache`** (unblocks G5/G7/G11; **M**).
10. **G5 + G11 — goal/thread tracking → goal-aware handoff brief** (**M–L**).
11. **G10 — competence detector** (**M**), **G13 — repetition detector** (**M**), **G15 — bounded re-generation** (**M**).

**Tier 3 — scale/latency:**
12. **G9 — parallel tool calls** (**L**; after G8). Interim: parallelize `replay:false` reads only (**M**).
13. **G3/G4 — recursive agent indexing + return-to-referrer + ping-pong suppression** (**M**).

**One-line framing for the roadmap:** the components fail on *wiring* (`retrievalCache`, `inputFilter`, tool-results-to-history) or *scoping* (`runId`, `__flowPark`, `activeFlow`-on-handoff) far more than on missing subsystems — so the distance from "clears the chatbot-with-voice bar" to "passes the agentic-voice rubric on its own worked example" is **Tier 0 + G8**, then the goal/thread layer. None of it is voice.

**Cross-references to `docs/kuralle-core-teardown.md`:** durability G8 = F6/F4/H1/H3 §2 & §9.1; handoff chimera G16 + mid-flow crash G17 + dropped summary G12 + ping-pong G4 = §6 & §9.3; free-conversation history loss G18 + lossy `reset_with_summary`/degraded-fabrication G7 = §5; `outOfBandControl` default-off + context-blind classifier G2 = §4.2/§4.7; one-shot completed flows (F9) + `maxTurns` bricking (F7) = §4.8/§8; inert confidence gate G10 = §4.6; repair-pattern bar (3/16) = §8. **Positioning:** this doc grades the agent layer against an external *voice-framework* rubric; the teardown grades the same code against its own determinism/durability doctrine. Where they overlap they agree — and the teardown is the system of record for the durability and concurrency keystones.
