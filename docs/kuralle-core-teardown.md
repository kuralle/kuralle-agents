# kuralle-core — Complete Teardown (2026-07)

**Branch:** `test/core-audit-validation` · **Companion harness:** `packages/kuralle-core/test/audit-validation/` (F1–F9, all reproduce: `bun test test/audit-validation` → 20 pass)
**Method:** adversarial source read of the runtime loop (done in-session, first-hand), four parallel subsystem audits (sessions/durability, memory/compaction, flow/prompts, streaming/routing/voice), and three retrieval-led peer-harness studies (Pipecat + pipecat-flows + LiveKit Agents; OpenAI Agents SDK + LangGraph; Rasa CALM + Parlant + Mastra) via DeepWiki/official docs. Docs and comments were deliberately not trusted; every load-bearing claim below is `file:line`-verified, and the highest-severity delegated claims were re-verified first-hand. Paths are relative to `packages/kuralle-core/src/` unless noted.

---

## 1. What it is, and what it is becoming

**What it is.** A TypeScript conversational-agent runtime on the Vercel AI SDK: one tagless `defineAgent` primitive whose *shape is derived* from populated fields (`routes` → dispatch, `flows` → structured procedure, otherwise free conversation — `runtime/deriveAgent.ts:68-103`); a per-turn host loop (`runtime/hostLoop.ts`) that dispatches to an LLM guard-classifier, a flow engine (`flow/runFlow.ts`), or a free-conversation turn; a durable effect journal for tools (`runtime/ctx.ts:99-133`); whole-blob session persistence (`runtime/durable/SessionRunStore.ts`); AI-SDK-native gated streaming (`runtime/channels/streaming/`); voice via provider-native realtime with post-hoc gating.

**What it is becoming** (per `research/BLUEPRINT-whats-next.md`): *the reusable conversational harness* — the layer products build on the way Claude Code builds on Pi's agent core — with a planned tool-model cleanup (durable tools become THE tool field), a FileSystem/workspace primitive, lazy Skills, and eventually proactive usage-driven compaction and a session tree. The grading below is against **that** ambition — a framework third parties depend on for long-lived, money-moving conversations (WhatsApp commerce is the in-repo reference workload) — not against a demo bot.

**The identity bet** is R1's determinism doctrine ("programs that call LLMs"): SOP in flows not prompts, tools return data only, dispatch never leaks, transitions enforced outside the prompt. The teardown's central question: does the code keep that promise?

**Verdict in one paragraph.** The architecture is genuinely differentiated — no peer ships flows-as-SOP *plus* a per-tool-call durable journal *plus* voice flow-authority in one runtime — but the three headline guarantees are each **structurally compromised in the default configuration**: "exactly-once" is actually *once-ever-per-session* for stable-arg tools and *at-least-once* across crashes (§2); "deterministic core" is opt-in and the framework's own prompt layer ships ~60 lines of imperative SOP (§4); and the durable substrate (one blob, one mutex, one process) cannot survive the horizontally-scaled deployments the framework is explicitly built for (§3). Long-lived sessions — the flagship use case — are where most of the failure modes concentrate: journals grow without bound, `maxTurns` bricks the session, completed flows can never re-run, compaction is off by default.

---

## 2. The durability story, torn down (highest-stakes claims)

The README's headline is "durable tool execution." The journal (`ctx.tool` → `replayOrExecute`, keyed `sha256(runId, callsite-ordinal, name, args)` — `durable/idempotency.ts:17-24`) is real and ahead of every peer *in concept*. In implementation it fails in both directions:

| # | Finding | Severity | Evidence | Failure |
|---|---|---|---|---|
| **F6** (harness) | **Cross-turn stale replay.** `runId === sessionId` forever (`openRun.ts:37-39`); callsite ordinals reset to 0 every turn (`ctx.ts:60`, new ctx per `run()` at `Runtime.ts:199`); steps accumulate for the session's life. A *new* turn issuing the same tool + same args at the same ordinal hits the old key and **returns the cached result without executing**. | **CRITICAL** | `ctx.ts:105-111`, proven by `test/audit-validation/6-*.test.ts` (observed: second turn's `get_balance` never runs) | "Check my balance" answered with the week-old cached balance; a second identical order silently never placed. Any zero-arg or stable-arg tool is frozen to its first-ever result. |
| **F4** (harness, prior) | The dual: a preceding effect shifts the ordinal → same logical call gets a *new* key → **re-executes** (double-charge). | HIGH | `4-replay-journal.test.ts` | Code evolution or an added `ctx.now()` re-runs a payment on resume. |
| H1 | **Execute-then-record gap**: `await execute(); await appendLiveStep(...)` (`ctx.ts:113-116`). Crash between the two → re-execution on retry. At-least-once, not exactly-once. Temporal/Restate write an intent record first; kuralle doesn't. | HIGH | `ctx.ts:113-116` | `charge_card` succeeds; process dies before the step persists; retry charges again. |
| H2 | **Input ingestion is not idempotent** — `openRun` unconditionally appends the user message (`openRun.ts:99-114`); signals have dedupe (`durable/replay.ts:19-31`), plain input has none. | HIGH | `openRun.ts:99-114` | Webhook retry duplicates the user message and regenerates (re-sends) the answer. |
| H3 | **Journal never pruned.** No code clears `durableRuns[sessionId].steps` (grep negative); compaction touches only `messages`. Every effect from every turn lives in the session blob forever — and every `appendStep` + `putRunState` re-reads and re-writes the **whole blob** (2 GETs + 2 SAVEs per tool call, `SessionRunStore.ts:34-56,75-83`). | HIGH | `SessionRunStore.ts:50,54,81` | O(history) I/O per tool call; blob eventually hits Redis/JSONB/DO-cell size limits; long WhatsApp sessions degrade then break. |
| M4 | Non-deterministic args (raw `Date.now()` in a tool arg) silently defeat replay — nothing forces authors through `ctx.now()/uuid()`. | MEDIUM | `idempotency.ts:22-24` | Resume re-executes an effect that already ran. |

**Root cause, named:** the journal has no notion of a *logical run boundary*. Temporal scopes a journal to one workflow execution with a lifecycle; kuralle scopes it to a never-ending session and keys entries by source-position ordinals that are neither stable across code changes (F4) nor scoped to an invocation (F6). The fix is one decision, not five patches: **give the journal a real scope** (per-turn or per-flow-execution runId rotation, or turn-id in the key) and **write intent-before-execute**. Everything in this table follows from that.

Peer reality check: LangGraph documents this exact hazard honestly ("side effects called before interrupt should be idempotent" — its exactly-once is node-granular pending-writes); OpenAI Agents SDK has *no* durability without Temporal; Pipecat/LiveKit have none at all (a Pipecat issue documents zombie tool calls double-firing). Kuralle's primitive is still the best-in-class *idea* in this cohort — which is exactly why its two failure directions matter: it is the one guarantee peers can't match, and today it isn't true.

---

## 3. Concurrency & the substrate (deployment reality)

| # | Finding | Severity | Evidence | Failure |
|---|---|---|---|---|
| C2 | **All concurrency control is per-process.** `SessionMutex` is an in-memory map on the Runtime instance (`SessionMutex.ts:20-22`, `Runtime.ts:124`). Stores are whole-blob last-write-wins: Postgres `ON CONFLICT DO UPDATE SET data=EXCLUDED.data` (no version column — `kuralle-postgres-store/…:135-141`), Redis get-then-set (no WATCH/Lua — `kuralle-redis-store/…:144-152`). `appendStep`'s `LogConflictError` compares against the copy *it just read* — it cannot fire across processes. | **CRITICAL** for multi-instance | cited inline | Two workers get a webhook + its retry: messages duplicated/dropped, one worker's journal steps silently vanish, later index-gap `LogConflictError` bricks the run. The framework is single-process-safe only, and nothing says so. |
| — | **Abort-controller race**: `activeTurnAborts` is keyed by sessionId and set *before* the mutex is acquired (`Runtime.ts:142` vs `:391`); a queued second turn overwrites the running turn's controller, and its `finally` deletes the entry (`:369`). | MEDIUM | `Runtime.ts:123,142,369,391` | `abortSession()` aborts the *queued* turn; the running turn becomes unabortable. |
| — | **Mutex queue has no timeout** and the LLM call has none either (`streamText` gets only the abort signal, `TextDriver.ts:85-91`). | MEDIUM | `SessionMutex.ts:34-57` | One hung provider call wedges the session's queue until process restart. |
| — | **Crash-in-`openRun` masks the real error**: `execute`'s `finally` dereferences `opened.session` / `runCtx.runState` which are unassigned if `openRun` threw (`Runtime.ts:154,368-385`) — the store/signal error is replaced by a `TypeError`, and `hooks.onError` never sees the original. | MEDIUM | `Runtime.ts:147-385` | Undiagnosable production errors on store outage or signal mismatch. |
| M1 | Redis session TTL silently expires **suspended runs** (approval pending inside the blob); Postgres has no TTL at all — inconsistent lifecycle across backends. | MEDIUM | `RedisSessionStore.ts:153`, `Runtime.ts:613-616` | Human approves after TTL → "No run state for session". |
| H4 (harness **F7**) | **`maxTurns` bricks the session**: counter lives in session-lifetime `run.state`, only incremented, never reset (`policies/limits.ts:4,18-34`). | HIGH (if limits set) | `7-maxturns-bricks-session.test.ts` | A guard meant for one runaway turn permanently kills a busy thread. |
| N4 | `SessionManager` helpers and `getConversationLength` bypass the mutex entirely (read-modify-write, no lock). | LOW-MED | `SessionManager.ts:85-167`, `Runtime.ts:529-533` | Lost updates even single-process. |

Also: `done` is emitted in the `finally` even when the turn crashed with a non-degradable error (`Runtime.ts:384`) — **the SSE wire reports success on a crashed turn** and the rejected result promise is an unhandled rejection for events-only consumers (`events/TurnHandle.ts:66-69`). Client disconnect is not wired to abort anywhere in core — a dropped SSE connection burns tokens to completion.

---

## 4. The determinism doctrine, audited against its own code

This is the identity claim ("SOP lives in flows, not prompts"; "tools return data only"; "dispatch never leaks"). Score: **the machinery exists and is genuinely good — and nearly all of it is off by default, while the framework's own prompt layer violates the doctrine.**

1. **Determinism is opt-in, not the default** (harness F5). Any populated `instructions` string makes the agent an "answering agent" (`deriveAgent.ts:29-52`): free conversation runs first and flows are entered only if an LLM guard (`classifyHostTarget`, `generateObject` at temp 0 — `select.ts:84`) or the model's own control tool says so. The email-statechart ideal ("impossible to send without an approved draft") is inverted: the deterministic path is the exception that an LLM gatekeeps.
2. **The model can bypass reply-node transitions in default config.** `turn.control` from a model-called tool (`final`/`handoff`/`escalate`) short-circuits *before* `node.next` is consulted (`flow/runFlow.ts:216-251`). The silo that prevents this (`outOfBandControl`) is `experimental` and **defaults to false** (`types/agentConfig.ts:51-54`, `Runtime.ts:226`).
3. **The framework ships prose control flow.** `SUPPORT/SALES/TRIAGE` templates embed numbered SOPs (`prompts/templates.ts:26-74`), the `regulated` security profile is pure procedure ("Escalate if confidence < 0.8" — `prompts/security.ts:26-44`), `grounding_rules`/`tool_contract` are injected into every prompt (`PromptBuilder.ts:209-257`): ~60 imperative-rule lines, ~51 numbered steps, ≈1.2–2.5k tokens of framework boilerplate per flow node before the node's own instructions (`composeSystem` concatenates with no cap — `flow/nodeBuilders.ts:37-40`). R1 failure-mode #2, shipped in the box.
4. **Tool returns are the control channel by design** (harness F3, broader than one site): `classifyControl` runs on **every** model tool result (`executeModelTool.ts:41`); `final.text` is simultaneously user prose and the end-control payload; `__flow_transition` results carry control + prose + state in one object (`flows/transitions.ts:21-59`); decide-node structured output is `Object.assign`ed into flow state (`reduceTransition.ts:42-44`).
5. **The `guards/` subsystem does not guard conversations.** It's a coding-agent tool governor (`readBeforeEdit`, secret-scan on a `content` arg — `guards/rules.ts`); `defaultStopConditions`/`checkStopConditions` have **no caller** in runtime or flow. The name promises the doctrine; the code enforces none of it.
6. **Safety gates that no-op silently**: the confidence gate fires only if a validation policy populated `turn.confidence` — default `validate: []` (`resolvePolicies.ts:25`) means the documented gate is inert. Collect extraction never runs validation policies at all, and nothing verifies an extracted value actually appeared in user text (the only guard is a sentence in the tool description — `extraction/extraction.ts:110`). After `maxTurns` (10) a collect **force-completes with partial data**, bypassing `schemaSatisfied` (`flow/collectUntilComplete.ts:69-74`).
7. **Dispatch leaks in the default mode.** Relaxed dispatch streams tokens live and retracts via `text-cancel` after control fires (`hostControlSpeak.ts:91-99`); "routes silently" holds only in `strict`. And the routing classifier sees **only the latest user message** — no conversation context (`select.ts:50,220-239`) — so "yes please" routes blind.
8. **Flows are one-shot per session** (harness **F9**): completed flows are excluded from the guard's candidates *and* the `enter_flow` tool surface forever (`hostControlTools.ts:14-21`, `select.ts:56-61`); nothing ever clears `__completedFlows`. A customer cannot place a second order in the same session via routing. For a commerce-first framework this is a product-level defect, mechanically proven.
9. **Token-mode streaming bypasses the gate entirely** (harness **F8**): `speakGated` never calls `runGate` in token mode (`speakGated.ts:105-131`), so a processor that declares `streamGranularity: 'token'` disables its own enforcement — and post-turn control extraction with it.

**The honest framing the docs should adopt:** kuralle's default is the same "LLM decides, prompt pleads" shape it critiques; its determinism is a well-built opt-in. Either flip the defaults (silo control tools when a flow is active; make `outOfBandControl` non-experimental and on; feed the classifier context; reset `__completedFlows` on re-entry intent) or stop claiming determinism as the default posture.

---

## 5. Context, memory, compaction

| # | Finding | Severity | Evidence |
|---|---|---|---|
| F1 (harness, prior) | chars/4 estimation everywhere; `TokenAccumulator` (real usage) **never constructed**; `ContextBudget` drift detector never constructed; `computeMessageHistoryBudget` has **zero callers** (verified first-hand). | HIGH | `ContextBudget.ts:65,77,180` |
| — | **No default backstop**: compaction is opt-in (`config.compaction`, unset in every non-test config found); without it there is no trim *and* no overflow recovery (`Runtime.ts:259` requires it) → history grows until a provider 4xx, which is rethrown. | HIGH | `Runtime.ts:259,463` |
| — | **Images break the math both ways**: URL-form image ≈ 15 estimated tokens vs ~1k real (under-counts → no trigger); base64 image ≈ 170k estimated "tokens" (over-counts → futile summarizer loops since the image sits in the kept tail). No image-aware counting exists. | HIGH for WhatsApp | `compaction.ts:48-56`, `userInput.ts:14-18` |
| — | **Two uncoordinated summarizers**: runtime compaction (post-turn, thresholded) vs flow `reset_with_summary` (every transition, **on the latency path**, no threshold) — and `reset_with_summary` replaces history with a *single system message*, **dropping the last user message** (verified first-hand: `flow/contextStrategy.ts:69-71`), strictly lossier than plain `reset`. | MED-HIGH | `contextStrategy.ts:54-79`, `reduceTransition.ts:34` |
| — | Summarizer input truncates tool results to 200 chars — the prompt says "preserve result ids/amounts" but the transcript already cut them. | MED-HIGH | `compaction.ts:79-84` |
| — | Overflow regexes are OpenAI/Anthropic-shaped; Gemini/Vertex/Bedrock phrasings likely miss → no recovery (pattern-inspected, not byte-verified against live providers). | MEDIUM | `contextOverflow.ts:36-44,94-125` |
| — | FactMemory: unguarded load→LLM-merge→save keyed per **user**, while the mutex serializes per **session** → cross-session lost updates; plus one LLM call per turn-end when enabled. | MEDIUM | `factMemoryService.ts:89-145` |
| — | Compaction/wake/resume notes are injected as mid-array `system` messages — provider portability unverified. | LOW-MED | `compaction.ts:149-153`, `openRun.ts:121-127` |

Free conversation has a subtler transcript defect: only the final `turn.text` is persisted (`hostLoop.ts:208-210`); tool calls/results live in the driver-local array and the journal, not history. Next turn, the model has no record of what its own tools returned — "what did the search say?" is unanswerable, and pre-tool assistant text that *was* streamed to the user is absent from history (stream/transcript divergence).

## 6. Handoffs: a chimera agent (all first-hand-verified)

After a handoff the runtime updates tools/knowledge/memory surfaces (`Runtime.ts:299-317`) but **not**: `runCtx.baseInstructions` (still the *source* agent's persona — set once at `Runtime.ts:224`, single write site), `controlModel` (`:206`), the enforcer/limits/processors (`resolveAgentPolicies(opened.agent)` once at `:169`), or the `CoreToolExecutor` — whose tool map is `private readonly`, built once from the opening agent's surface (`:179-189`; no registration API exists). The `def`-path saves global/working-memory tools, but the target's registry-only tools (`knowledge_search`, `workspace`, flow-action `ctx.tool` calls) throw `Unknown tool`. **The post-handoff agent is a chimera: target's tools and knowledge, source's persona, policies, and executor.**

Plus (subsystem audit, spot-checked): handoff **input filters are dead code** — `handoffFilters.ts` fully implemented and exported, `route.filter`/`HandoffConfig.inputFilter` type-only, zero application sites (full history + working memory always transfer); the model-written handoff `summary` is dropped by `classifyControl` (`flow/classifyControl.ts:8-12`); a mid-flow handoff leaves `run.activeFlow` set → the *target* agent throws `Active flow not found` (`hostLoop.ts:57-62`, `runFlow.ts:216-217,325-327`); and `handoffCount` resets every user turn (`Runtime.ts:241`) so A→B→A ping-pong one-hop-per-turn is unbounded — `handoffHistory` is written but never read for loop suppression.

## 7. Voice, scheduling, and the rest

- **Voice:** turn-taking/interruption authority is fully provider-side (VAD, `interrupt_response` — provider session config); kuralle reacts and truncates the transcript to `heardCharCount` (`VoiceDriver.ts:410-423` — this part matches Pipecat/LiveKit best practice). The output gate on native audio is *explicitly advisory* (`gateScope='advisory'`, `VoiceDriver.ts:201-205`): unsafe speech plays, then a spoken correction. Honest in code, absent from marketing. Kuralle does retain tool/flow authority in realtime — the one capability neither the OpenAI Realtime SDK (no flows) nor pipecat-flows (explicitly unsupported on speech-to-speech models) offers. That's the moat; the advisory gate is its cost.
- **Scheduler:** the default is a bare `setTimeout` map (`scheduler/index.ts:30-67`) — scheduled wakes are silently lost on restart unless a durable adapter is injected. "Engagement/broadcast/drip" exists only as a comment.
- **Degraded turns fabricate history:** the canned `SAFE_DEGRADED_MESSAGE` is appended as a real assistant message (`Runtime.ts:354-362`) — memory ingest and future turns treat words the model never said as its own.
- **`TurnResult` lies:** the awaited result's `toolResults` is always `[]` and `text` is only the last assistant message if it happened to be a string (`Runtime.ts:387,655-661`).

---

## 8. The agent loop vs. peer harnesses (retrieval-led)

Sources: DeepWiki over `pipecat-ai/pipecat(-flows)`, `livekit/agents`, `openai/openai-agents-python/js`, `langchain-ai/langgraph`, `emcie-co/parlant`, `mastra-ai/mastra`; rasa.com CALM docs; parlant.io; mastra.ai; issue trackers. (Full briefs in session; key citations inline.)

| Capability | kuralle-core | Best-in-class peer | Read |
|---|---|---|---|
| Structured SOP | flows (reply/collect/action/decide), LLM-guard entry | **Rasa CALM**: LLM emits *commands only* from a closed vocabulary (`start flow`, `set slot`, …); a deterministic manager walks the graph — skipping steps is structurally impossible | Rasa inverts kuralle's default: the LLM literally cannot produce anything but commands. Kuralle's collect node matches this bar; its reply node and free-conversation default don't. |
| Conversation repair | digression (off by default), oscillation counter, confirm-parse | **Rasa's 16 named overridable patterns** (correction, clarification, interruption+resume, skip, cancel, silence, repeat, …) | The 2026 reference bar. Kuralle has ~3 of 16, unnamed and gated behind an experimental flag. |
| Grounded output | opt-in validators (default `[]`), advisory voice gate | **Parlant strict canned responses** (only pre-approved templates → "hallucinations eliminated"); Rasa's rephraser starts from a template | Kuralle's "your order is placed" honesty rests on an off-by-default validator and a sentence in a tool description. |
| Durable effects | per-tool-call journal (broken per §2) | **Nobody ships true exactly-once.** LangGraph = node-granular pending-writes + documented idempotency warning; Agents SDK = Temporal or nothing; Pipecat/LiveKit/Mastra/Parlant = at-least-once / dedupe hints | Kuralle's unique differentiator — worth fixing before anything else, because it's the claim no peer can make. |
| Checkpointing / time travel | none (flat blob; F2 harness: no tree/fork) | **LangGraph**: thread checkpoints, fork from any checkpoint, pending-writes replay | The Pi-gap doc's Phase-3 "session tree" matches; LangGraph is the proof it's table stakes for durable frameworks. |
| Handoff hygiene | filters dead, summary dropped, chimera ctx (§6) | **Agents SDK**: working `input_filter` chain, `nest_handoff_history` transcript collapse | Kuralle has the *types* for what Agents SDK ships working. |
| Interruption → history truth | voice: truncate-to-heard ✓; text: retract-by-`text-cancel`, history keeps unspoken text | **Pipecat**: word-timestamp-aligned partial commit; **LiveKit**: `synchronized_transcript` + server-side truncate | Kuralle's voice path is at par; the text retract path leaves history/user divergence. |
| Token accounting | chars/4 (F1) | **LiveKit**: real provider `CompletionUsage` aggregation | Pipecat also estimates (4 chars/tok) — kuralle is mid-pack here, but it *built* the real-usage accumulator and never wired it. |
| Turn-loop cost | 2 GETs+2 SAVEs per tool effect; ≥6 store round-trips in `openRun`; guard adds an LLM call on empty turns | peers hold context in memory during a turn | Whole-blob-per-effect is unique to kuralle — and uniquely expensive. |
| Voice flow authority | **kuralle wins** | pipecat-flows: *unsupported* on speech-to-speech models; Agents SDK realtime: no flow primitive | The single strongest differentiator to protect and market. |
| Loop bounds | maxSteps=5, maxHandoffs=5/turn (cross-turn unbounded), maxTurns bricks (F7) | Agents SDK `max_turns=10` per run (resets naturally); LangGraph `remaining_steps` graceful degradation | Kuralle's counters are session-cumulative where peers' are run-scoped — the same scoping bug as the journal, in a second place. |

**2026 conversational-framework checklist** (union of Rasa/Parlant/Mastra expectations): declarative SOP ✓ · structural enforcement **default-off** · named repair patterns ✗ (~3/16) · digression stack-resume ~ (experimental, can mutate flow state pre-guard) · slot validation loops ~ (no declarative rejections; force-complete hole) · durable event-sourced state ~ (blob, not events; no fork) · grounded/canned output ✗ (opt-in validators only) · safety processor pipeline ✓ (input gating real) · explainability artifacts ~ (telemetry events; no per-decision rationale) · bounded-autonomy escape hatch ✓ (free conversation inside flows — arguably *too* open by default).

---

## 9. What to fix, in order (keystones, not a backlog)

1. **Scope the journal** (fixes F4+F6+H3+F7 in one decision): rotate `runId` per logical execution (turn or flow-run), or add turn identity to effect keys; prune steps at run close; write intent-before-execute for effects (fixes H1); idempotency-key inbound input (H2). This is the guarantee no competitor has — make it true before adding anything.
2. **Make the substrate honest about concurrency**: versioned CAS saves in Redis/Postgres stores (or document single-writer/DO-only deployment loudly); fix the abort-map race; timeout the mutex queue and the provider call; fix the `finally` crash-masking and stop emitting `done` on crashed turns.
3. **Flip the determinism defaults**: promote `outOfBandControl` out of experimental and default it on for in-flow turns; reset `__completedFlows` (or add re-entry semantics) — F9 blocks repeat business; give the classifier conversation context; wire the handoff chimera (rebuild instructions/policies/executor per target — and either apply `handoffFilters` or delete them).
4. **Wire what's built**: `TokenAccumulator` + real-usage compaction trigger (the Pi/LiveKit pattern, already researched in-repo); default-on compaction with an image-aware floor; kill the flow-transition summarizer or unify it with compaction; run validation on collect extraction.
5. **Truth in claims**: README/docs must say — exactly-once is per-idempotent-invocation (post-fix), voice gating is advisory on native audio, determinism requires configuration X, single-process unless store supports CAS. The codebase is more honest than the docs; close that gap in the docs' direction.

Alignment note: Blueprint Phase 0 (tool-model cleanup) is correct but *second* — the journal-scoping fix is upstream of it, since every new capability (fs tools, skills) lands on `ctx.tool` and inherits its semantics today.

## 10. Harness delta (this audit)

Added to `test/audit-validation/` (all reproduce; each flips when its finding is fixed): `6-cross-turn-stale-replay` (F6), `7-maxturns-bricks-session` (F7), `8-token-mode-gate-bypass` (F8), `9-completed-flow-oneshot` (F9). Prior F1–F5 re-verified green this session. Not mechanically captured (documented only): H1 execute-then-record gap, C2 cross-process clobbering, the handoff chimera, `done`-on-crash — each needs a fake-model or multi-process harness; worth adding when the fixes land.
