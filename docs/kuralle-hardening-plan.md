# Kuralle core-primitive hardening plan — engine parity + stop the flakiness

Source: multi-agent workflow benchmarking Kuralle's core primitives against ElevenLabs ElevenAgents + triangulation across the real peer engines (Vapi, Retell, LiveKit Agents, TEN, Pipecat/Pipecat Flows, OpenAI voice-agents, Intercom Fin). Grounded in `docs/kuralle-stability-rootcause.md`, the actual code (file:line below), and the shipped W-series (W1/W9/W3). This plan **supersedes the pending half** of `docs/kuralle-stability-impl-plan.md` (W2/W4/W5/W7/W8) by concretizing and re-sequencing it; the shipped items (W1/W9/W3) are kept and built upon.

## On "Recall Agent Engine" — it does not exist

The benchmark explicitly looked for it and found **no conversational/voice agent orchestration engine named "Recall."** The name resolves to four unrelated things, none ElevenAgents-comparable:
1. **Recall.ai** (YC W20) — a meeting-bot / Output-Media API (send bots into Zoom/Meet/Teams, capture audio/transcripts, stream media back). Their own docs: all agent intelligence/turn-taking/tools live in *your* app (their demo pipes to OpenAI Realtime). It's media I/O, not orchestration.
2. **"recall memory"** — a memory *tier* concept in Letta/MemGPT-style frameworks (searchable recent history), a mechanism inside other engines.
3. **Recall-Space/agent-builder** — a tiny (v0.1.1) Python builder lib; its voice path wraps OpenAI Realtime.
4. **Microsoft Recall** — a Windows screenshot-timeline feature.

So the genuine parity bar is set by **ElevenAgents + Vapi/Retell/LiveKit/TEN/Pipecat/OpenAI/Fin**, not "Recall." (The agent did not fabricate primitives for a non-existent product — the honest non-finding is itself the answer.)

## The six root causes of flakiness

1. **Control fused into generation (the keystone).** Every control surface has the model *speak AND self-select the control action in the same pass*: `TextDriver.runAgentTurn` merges node+driver+global tools into one `aiTools` dict; control is recovered only post-hoc by `classifyControl` reading the tool *result* (`TextDriver.ts:97,116`). Routing (`select.ts:57`), decide branching (`runStructured` prompt-instruction "pick one id", `TextDriver.ts:165-169`), and collect extraction are all LLM classifications with no out-of-prompt evaluator. **This is the direct cause of "works on gpt-4.1-mini, derails on gemini-3.1-flash-lite"** — control inherits the model's nondeterminism and provider variance.
2. **No provider/decoding pinning on the control path; the speaker model is the classifier.** Extraction/decide/routing use `ctx.model` at default sampling (only `routing.model` is separable). Same prompt → different routes/branches/extractions across providers and runs.
3. **Routing is entry-only and irreversible; off-script input is discarded.** `selectHostTarget` runs only when `activeFlow` is undefined; once in a flow a new message is force-fed to the active node and extraction discards model prose (`extractionTurn.ts:35-36`). A digression/intent-switch mid-flow is silently dropped or fabricates a field. A wrong first route is sticky for the whole flow.
4. **No turn-concurrency guard + single-slot, throw-on-empty input buffer.** `openRun` never reads `runState.status`; the pending buffer is one overwritable key that throws when empty (`inputBuffer.ts:9-15`). Two overlapping `run()` calls on one session (double-tap, retry, multi-tab, reconnect) race: last-writer-wins eats a message, or an empty consume throws. Pure timing-dependent nondeterminism, no detection path.
5. **No reachable confidence/grounding gate; a blocked turn doesn't reroute.** The `ValidationCapability` pre-emit machinery runs (`TextDriver.ts:134`) but `resolveAgentPolicies` hardcodes `validationPolicies:[]`/`refinementPolicies:[]` (`resolvePolicies.ts:26-27`) with no `defineAgent` entry point; `knowledgeCitations` is hardcoded `[]`; on `block` the gate emits a fallback and **the flow proceeds as if the turn happened**. Provider-dependent hallucinations (the reproduced "order placed" lies) surface verbatim — Fin's Validate-Accuracy mechanism is structurally unreachable.
6. **Tool execution is inline-blocking — no latency masking, no timeout, serialized fan-out.** Every model tool runs synchronously in the generation loop; no user text emits until the whole loop finishes. The interim filler is dead code (`CoreToolExecutor` calls `onInterim` but `Runtime` never passes it, `Runtime.ts:125-129`). No per-tool timeout → a hung tool blocks forever and **throws nothing, so W1's recovery boundary never fires**. `parallelExecution` defaults false. Net: fast tool feels instant, slow tool feels hung → users re-send into the racy buffer (cause 4).

## Hardening items

| ID | Pri | Effort | Title | Stops flakiness by | vs W-series |
|----|-----|--------|-------|--------------------|-------------|
| **H2** | P0 | S | Pinned, temperature-0 control-model channel distinct from the speaker | Removes sampling/provider variance from routing+decide+extraction — same prompt → same decision run-to-run, provider-to-provider | NEW (cross-cuts W2/W4/W5; cheapest highest-leverage lever) |
| **H3** | P0 | M | Per-session turn lock + ordered FIFO input inbox | Kills the overlapping-turn race + single-slot clobber/throw; multiple inputs drive multiple nodes without re-prompting | NEW (substrate for W4 + the W2 evaluator) |
| **H1** | P0 | L | Out-of-band control evaluator: separate generation from dispatch (**the keystone**) | Decouples the control decision from free-form generation so dispatch stops inheriting model nondeterminism; model can't narrate an un-called action; transition resolved BEFORE text is committed | **is W2**, made concrete (minimal node-scoped prompt + pre-emission transition + per-node tool siloing) |
| **H4** | P1 | M | Constrained-enum decide + code-first routing inversion | Branch selection becomes a closed `z.enum` of real edge ids (invalid branch impossible); code predicate tried before any LLM; keyword/single-flow routing runs before `generateObject` | extends W9 (generalizes the deterministic-gate pattern to all decides); reranks W2 routing |
| **H6** | P1 | M | Author-reachable confidence/grounding gate that reroutes on block | Low-confidence/ungrounded reply is blocked and routed to disambiguate/escalate (→ W1 recover/escalate) before the user sees it; threads `SourceRef[]` so grounding is *enforced*, not just retrieved | merges W7 + extends W3; reuses W1 |
| **H5** | P1 | L | In-flow digression evaluator + intent-split at the input boundary | Off-script turn is answered/re-routed (answer-then-resume) instead of force-fit into the active node; no fabricated field, no silent half-drop, no sticky wrong route | **is W4**, concretized; depends on H1+H2+H3 |
| **H7** | P2 | M | Tool execution modes + wire the dead interim filler + per-tool timeout | Slow tool speaks a filler instead of hanging; `post_speech` avoids acting on a half-spoken turn; **timeout converts a silent hang into a recoverable W1 error**; parallel fan-out makes latency MAX not SUM; async flows through the effect log (preserves exactly-once) | extends W8; the `timeoutMs` + async-via-effect-log clauses are NEW |
| **H8** | P2 | M | Per-turn control-decision trace + wire dead extraction telemetry + post-session eval criteria | Makes flakiness diagnosable and regressions catchable continuously (the gpt-vs-gemini gap becomes an in-engine signal, not a manual discovery) | NEW eval primitive + wires existing-but-unemitted observability hooks |

## Recommended sequence

- **Phase 0 (land first, parallel, de-risks everything):** **H2** (pinned control model — S, immediately attacks provider variance, makes every later LLM fallback deterministic) ‖ **H3** (turn lock + FIFO inbox — independent of LLM work, removes the concurrency race).
- **Phase 1 — keystone:** **H1** (out-of-band control evaluator; the W2 deliverable; host for H4/H5/H8). Builds on H2.
- **Phase 2:** **H4** (constrained-enum decide + code-first routing). On H1, fallback via H2.
- **Phase 3:** **H6** (confidence/grounding gate → W1 reroute). Merges W3+W7.
- **Phase 4:** **H5** (in-flow digression / multi-intent). Depends on H1+H2+H3.
- **Phase 5:** **H7** (tool modes; ship `timeoutMs` early — it feeds W1 recovery; async MUST flow through the effect log).
- **Phase 6:** **H8** (decision traces + eval criteria; turns flakiness into a continuous signal).

## W-series reconciliation (one line each)

- **W1** (recovery boundary) — shipped; reuse target for H6 block→reroute and H7 timeout→degrade. No change.
- **W9** (deterministic confirmGate) — shipped; H4 generalizes the pattern to all decides. Build on it.
- **W3** (per-node grounding) — shipped; H6 extends it to *enforcement* by threading `SourceRef[]`.
- **W2** (split control/generation) — **= H1** (keystone), kept #1, now concrete; H4 reranks its routing.
- **W4** (digression/multi-intent) — **= H5**, kept, re-sequenced AFTER H1/H2/H3.
- **W5** (deterministic collect/repair) — **folded** into H3 (FIFO replaces consume-once) + H4 (extraction confidence) + H6 (re-ask on low confidence). Superseded as a standalone.
- **W7** (confidence gate) — **merged into H6** (shares the unreachable ValidationCapability plumbing).
- **W8** (tool modes) — **= H7**, downgraded to P2 (dead-air is latency not a crash) EXCEPT the per-tool **timeout** split out as a NEW correctness sub-item.

## North star

**Determinism in the control path + provider-independence.** The single cheapest lever is **H2** (pin a temperature-0 control model distinct from the speaker) — it directly attacks the gpt-4.1-mini-vs-gemini-3.1-flash-lite reliability gap with an S-effort change and de-risks every other control change. Ship it first.
