# Work Breakdown Structure — Streaming-by-default

> **The build plan, sprint by sprint, end-to-end.** Spans the streaming-by-default RFC (`docs/rfc-streaming-by-default.md`) — incremental commit at the smallest guardrail boundary, unifying text and voice on the sentence boundary, with a breaking lifecycle event protocol. Every sprint is an end-to-end demoable slice, not a horizontal slab. Cadence and engineering practice are the same across all sprints.

---

## 1. Cadence and engineering practice

### 1.1 Cadence
- **1w sprints.** Planning at session start; implementation (Phase A) then sprint-level review (Phase B) within the session; warm-down at the end.
- **One sprint goal**, expressed as a single sentence with a verifiable outcome.
- **2–5 stories per sprint.** Smaller is better. Each story ships independently.
- **No carry-over.** If a story slips, it goes back to the backlog, not the next sprint as-is. Rewrite the story.

### 1.2 Definition of Done (universal)
A sprint's stories are collectively Done when **all** of the following hold:

1. Every story commits atomically (`[S{N}-{nn}] {title}`) on the **active build branch** (`plan/streaming-by-default` — see `sprints/STATE.md` § Build branch) with green CI on the project's supported runtimes (Bun + Node; **`bun run typecheck:all` is the full gate**, plus `bun run test`).
2. Unit tests written for every new exported function / class. **Coverage is not the metric**; *behavioral coverage* is — every public surface tested with at least one happy-path and one failure-path test, using the offline patterns already in `packages/kuralle-core/test` and the `@kuralle-agents/realtime-audio` / `kuralle-e2e-tests` fake-client suites.
3. **Passes sprint-level manager review (Phase B — after every story has proceed evidence):** manager sandwich review on full diff + briefs + proceed artifacts; blockers/majors resolved in fix pass. Optional `/delegate-review` when adversarial second opinion is explicitly needed.
4. **Public surfaces match the source RFC.** Diffs to the RFC (event shapes, mode names, interface signatures) require an explicit RFC amendment in `docs/rfc-streaming-by-default.md` in the same sprint.
5. **Stream events match the RFC lifecycle taxonomy.** After Sprint 1, the only assistant-text events are `text-start` / `text-delta{id,delta}` / `text-end` / `text-cancel{id,reason}`, on **both** `HarnessStreamPart` (`types/stream.ts`) and the voice union (`types/voice.ts`). `typecheck:all` proves every exhaustive switch over the union still compiles.
6. Docs updated in the same change: package READMEs, `apps/docs/`, and `docs/skills/` where they reference streaming or the event shape. **No feature ships without docs** (repo rule).
7. Manual demo artifact captured per story or per sprint: an offline transcript or a runnable example invocation showing the event sequence (not just a typecheck).
8. **No `--no-verify`, no `@ts-ignore`/`as any` suppression, no silent-catch shortcuts, no compatibility shim for the old event shape (REQ-11).** If you can't meet a check, change the design, not the gate.

### 1.3 Branching and commits
- **Build branch:** `plan/streaming-by-default` (canonical name in `sprints/STATE.md` § Build branch), cut from `main` at the start of Sprint 0. All Phase A story commits and Phase B fix/closeout commits land on this branch. **Do not commit to `main` during a sprint session.** Merge to `main` happens via a single PR after Sprint 4 ships, paired with the real `pnpm release`.
- IC commits per-story atomic implementations. Manager commits the fix pass + closeout.
- Every commit message includes the story id (or `[S{N}-fix]` / `[S{N}-close]`) and a body summarizing the diff. Commit bodies end with the repo's `Co-Authored-By` trailer.
- Demo artifact links live in the commit body.

### 1.4 The review loop (proceed evidence in Phase A; manager review in Phase B)

**Phase A — IC + proceed evidence (no review workers):**

1. **IC implementation.** `cursor` fired fresh per story via `/delegate --mode impl`. Proof JSON, atomic commit. One worker = one story = one context window.
2. **Code map (when needed).** Before briefing, manager runs **`/code-understand`** for unfamiliar surfaces (the channel drivers, the policy gate, the realtime client); links `.understanding/<slug>.md` in brief **Read These First**.
3. **Proceed evidence (manager).** After each story: diff + `verify-handoff-proof.sh` → `proceed-S{N}-{nn}.md`. **`PROCEED`** → next story. **`HOLD`** → re-delegate IC only.
4. Repeat until every story has **`PROCEED`**.

**Phase B — manager review (only after Phase A complete):**

5. **Manager sandwich review.** Full sprint diff + every brief + every proceed file → `review-sprint.md` (`REVIEW-r1.md` shape). For Sprint 1 (the breaking flip) and Sprint 3 (cascaded TTFT), `/delegate-review` is **recommended, not optional** — the blast radius and the latency claim both warrant an adversarial second opinion.
6. **Manager fix pass.** Commit `[S{N}-fix] {description}`.
7. Sprint closes when WARMDOWN + HANDOFF + STATE-update commit lands.

### 1.5 Sprint warm-down (handoff to the next session)
Last hour of every sprint. Two artifacts:

1. `sprints/sprint-N/WARMDOWN.md` — what shipped, what's working, what's not, open issues, decisions made, RFC amendments this sprint.
2. `sprints/sprint-N/HANDOFF.md` — a one-page primer for the next session: read-me-first, current state of the world, sprint N+1 starting state.

The next session reads HANDOFF first, WARMDOWN if it needs depth.

---

## 2. The roadmap

| Sprint | Phase | Goal (one sentence) |
|--------|-------|---------------------|
| 0 | Primitives | Ship the mode selector, sentence aggregator, and the `streamGranularity` gate field as additive, fully-tested modules with zero behavior change and the repo still green. |
| 1 | Protocol flip + text | Replace the single-shot `text-delta` with the four-variant lifecycle across both unions and route `TextDriver` through the shared `speakGated`, so an ungated text reply emits multiple deltas before turn-end and a grounded node still buffers. |
| 2 | Voice (native realtime) | Route `VoiceDriver` through the same `speakGated` path so the native realtime transcript streams incrementally and the whole-answer gate runs honestly post-hoc (REQ-9), with barge-in/truncate preserved. |
| 3 | Cascaded TTFT | Make the LiveKit cascaded adapter consume `text-delta.delta` and handle the lifecycle so first TTS audio begins before the runtime turn completes and `aria_runtime_ttft` drops to first-token latency. |
| 4 | Polish + 0.4.0 | Land the live streaming smoke example, the docs/ADR-0004 amendments (including the native-realtime caveat), and the unified `0.4.0` version bump with a clean publish-together dry run. |

The phases above map to the source RFC as follows:

- **Sprint 0** implements RFC chunks **C2** (`streamGranularity` field, §4.6/REQ-5), **C3** (`resolveStreamMode`, §4.3/REQ-4), **C4** (`SentenceAggregator`, §4.4/REQ-2). All additive — the union and drivers are untouched, so the repo stays green.
- **Sprint 1** implements **C1** (lifecycle event types, §4.1–4.2/REQ-6,7 — the breaking flip), **C5** (`speakGated` + `TokenSource`, §4.5/REQ-1,3,7,8), **C6** (`TextDriver` on the shared path, §5.1/REQ-1,3,12). Because C1 changes the shape of `text-delta`, this sprint also mechanically updates every emit/consume site that would otherwise fail to compile — `Runtime.ts:131,246`, `VoiceDriver` emit calls, the cascaded adapter, and all text-path tests (the compile-critical part of **C9**, §8) — so the sprint closes green. Voice and the adapter are updated to the new shape but keep their current buffered behavior here; their true streaming lands in Sprints 2 and 3.
- **Sprint 2** implements **C7** (`VoiceDriver` on the shared path, §5.1/REQ-8,9) plus its voice tests (the voice slice of **C9**).
- **Sprint 3** implements **C8** (cascaded adapter true streaming + TTFT, §7/REQ-10) plus the adapter/e2e tests (the cascaded slice of **C9**).
- **Sprint 4** implements **C10** (live smoke + docs + ADR 0004, §8/REQ-9) and **C11** (unified `0.4.0` bump + changeset, §8/REQ-11).

---

## 3. Sprint detail

The format below repeats per sprint. Stories use the id pattern `S{N}-{nn}` (e.g. `S0-01`).

### Sprint 0 — Primitives

**Goal:** ship `resolveStreamMode`, `SentenceAggregator`, and the `streamGranularity` gate field as additive, unit-tested modules — repo behavior unchanged, `typecheck:all` and `test` green.

| Story | Description | DoD |
|-------|-------------|------|
| S0-00 | Cut `plan/streaming-by-default` from `main`; confirm baseline by running `bun run build`, `bun run test`, `bun run typecheck:all` and recording the pass/fail counts in `sprint-0/PLAN.md`. | Branch exists; baseline counts recorded (honest — if anything is red at HEAD, it is documented before any change). |
| S0-01 | Add optional `readonly streamGranularity?: 'sentence' \| 'turn'` to the output `Processor` type (`types/processors.ts`) and the `ValidationPolicy` type (`capabilities/ValidationCapability.ts`). Document the default-`turn` semantics in the typedoc. Additive only — no consumer changes. | Field present; existing policies/processors compile unchanged; `typecheck:all` green; a doc line states "absent ⇒ `turn` (buffered, safe)". |
| S0-02 | Implement `SentenceAggregator` + `matchEndOfSentence` in `runtime/channels/streaming/SentenceAggregator.ts`. Hand-rolled boundary detection (terminal punctuation + lookahead guard for decimals/abbreviations); no NLP dependency. `push(text): string[]`, `flush(): string \| null`. | `aggregator.boundaries` test green: splits `"Hi there. How are you?"` → 2; keeps `"$29.99 is the price."` intact; `flush()` returns the trailing partial; abbreviation list (`Mr.`, `Dr.`, `e.g.`, `i.e.`) does not split. |
| S0-03 | Implement `resolveStreamMode(ctx, node): 'token'\|'sentence'\|'turn'` in `runtime/channels/streaming/mode.ts`. Coarsest-wins over `ctx.outputProcessors`, `ctx.validationPolicies`, and the node's active whole-answer grounding gate; `token` when none attached; undeclared granularity ⇒ `turn`. | `mode.test` green: no gates ⇒ `token`; one `sentence` policy ⇒ `sentence`; any `turn` policy or active grounding gate ⇒ `turn`; mixed ⇒ coarsest. Pure function (no I/O). |

**Demo:** an offline test run (`bun run test` filtered to `mode.test` + `aggregator.boundaries`) showing both suites green, plus a one-line typecheck-clean confirmation. No runtime behavior changed — proven by the existing flow/voice suites still passing.

**Dependencies:** none.

**Source RFC §:** §4.3 (C3), §4.4 (C4), §4.6 (C2); REQ-2, REQ-4, REQ-5.

**Sprint-specific risks:**
- `matchEndOfSentence` over/under-splitting on real transcripts → detection: table-driven test with decimals, abbreviations, ellipses, multi-punctuation; mitigation: lookahead before declaring a boundary (mirrors Pipecat `simple_text_aggregator.py:104-110`); if a real transcript later breaks it, that is a backlog item, not a blocker.
- `resolveStreamMode` reading a grounding signal that does not yet exist on `RunContext` → detection: typecheck; mitigation: locate the node's grounding-gate signal during `/code-understand` before briefing S0-03; if it is implicit, the story adds a small predicate `nodeHasWholeAnswerGroundingGate(ctx, node)` grounded in the existing grounding scope (`runtime/grounding/index.ts`).

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 1 — Protocol flip + text path

**Goal:** replace the single-shot `text-delta` with the `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle across both unions and route `TextDriver` through `speakGated`, so an ungated text reply emits more than one delta before turn-end while a grounded node still buffers — `typecheck:all` and `test` green at close.

| Story | Description | DoD |
|-------|-------------|------|
| S1-01 | **Breaking flip (C1).** In `types/stream.ts` and `types/voice.ts`, remove `{ type: 'text-delta'; text: string }` and add the four lifecycle variants. Update **only the mechanical emit sites** so the repo compiles: `Runtime.ts:131` (`onInterim`) and `:246` (degraded message) emit a complete `text-start`/`text-delta`/`text-end` for their single string; `VoiceDriver` and the cascaded adapter are updated to the new shape but keep current buffered behavior. | `typecheck:all` green (every exhaustive switch over both unions compiles); existing tests updated to assert the new shape; no `text` field remains on any `text-delta`; no compat alias. |
| S1-02 | **`speakGated` + `TokenSource` (C5).** Implement `runtime/channels/streaming/speakGated.ts`: `token` mode emits each delta live; `sentence` mode gates each completed sentence and emits cleared ones (block ⇒ `text-cancel` + fresh safe message); `turn` mode accumulates, gates once, emits. Exactly one `text-start`/`text-end` per turn (REQ-7). Error in the source emits `{type:'error'}` then closes with `text-cancel` if started. | `speakGated.modes` test green for all three modes incl. the sentence-block path and the turn-block (grounding) path; one start/end pair per turn asserted; blocked sentence text never appears in the emitted stream. |
| S1-03 | **`TextDriver` on the shared path (C6).** Replace the accumulate-then-emit block (`TextDriver.ts:58-147`) with a `TokenSource` over `streamText().fullStream` feeding `speakGated`; preserve the tool-call step loop and `applyPostTurnPolicies` as the `runGate`. `runExtraction` untouched (REQ-12 — extraction never speaks). | An ungated reply integration test asserts **>1** `text-delta` and the first arrives before `turn-end`; a grounded-node test asserts buffered emit + no blocked content; extraction test asserts zero text lifecycle events; full `test` + `typecheck:all` green. |

**Demo:** run a text example end-to-end (offline or live smoke) and capture the SSE event sequence showing `text-start` → multiple `text-delta{id,delta}` → `text-end` for an ungated node, and a single buffered message for a grounded node. `grep -c '"type":"text-delta"'` > 1 on the ungated transcript.

**Dependencies:** Sprint 0 (`resolveStreamMode`, `SentenceAggregator`).

**Source RFC §:** §4.1–4.2 (C1), §4.5 (C5), §5.1 (C6); REQ-1, REQ-3, REQ-6, REQ-7, REQ-8, REQ-12.

**Sprint-specific risks:**
- **Invariant breach (hard stop):** sentence mode emits a blocked sentence's text. Detection: `speakGated.modes` block case asserts the blocked text is absent from the captured stream. Mitigation: gate the sentence **before** the `text-delta` emit; if a breach is observed, **stop and do not ship** (RFC §11 abort).
- Large blast radius of the union change leaving a consumer red. Detection: `typecheck:all` is the gate; CI must be green at close. Mitigation: `/code-understand` the `HarnessStreamPart`/voice-union consumers before S1-01; `/delegate-review` recommended on this sprint.
- Out-of-order or duplicate `text-start`/`text-end`. Detection: REQ-7 assertion in `speakGated.modes`. Mitigation: single `started` latch in `speakGated`.

**Exit criteria:** all stories Done; ungated streaming + grounded buffering both demoed; WARMDOWN + HANDOFF written.

---

### Sprint 2 — Voice (native realtime)

**Goal:** route `VoiceDriver` through `speakGated` via a transcript-backed `TokenSource` so the native realtime assistant transcript streams incrementally, with the whole-answer gate running honestly post-hoc (REQ-9) and barge-in/truncate preserved.

| Story | Description | DoD |
|-------|-------------|------|
| S2-01 | **Transcript `TokenSource` (C7a).** Adapt the `onTranscript` assistant-text stream (`VoiceDriver.ts:172-180`) into a `TokenSource` feeding `speakGated`, replacing the accumulate-then-emit block (`VoiceDriver.ts:65-106`). Preserve `heardCharCount`, `truncateAt`, and the barge-in/`onInterrupted` mechanics. | Voice text events now stream incrementally (>1 `text-delta` for a multi-sentence turn) in the fake-realtime-client test; truncate-on-interrupt still yields the heard prefix; `typecheck:all` + voice suite green. |
| S2-02 | **Honest post-hoc gate (C7b, REQ-9).** On the native realtime path a `turn`-granularity gate runs **after** the provider has spoken: emit the relevant `safety-*` / `pipeline-validation-*` events and, on block, trigger the provider interrupt + correction utterance — but do **not** claim emission was prevented. Document the constraint in the voice README and the driver. | A fake-client test asserts a blocking gate on native realtime emits the `safety-*` event + a correction, and that the gate result is recorded as advisory (not "blocked-before-emit"); README states whole-answer content gates are advisory on native realtime and input-side gating + tool authority are the reliable controls. |

**Demo:** fake-realtime-client transcript showing incremental `text-delta` during a turn, a barge-in mid-turn yielding the truncated heard prefix, and a post-hoc gate firing a `safety-*` event + correction utterance. Captured as a transcript artifact under `sprint-2/`.

**Dependencies:** Sprint 1 (`speakGated`, lifecycle events).

**Source RFC §:** §5.1 (C7), §10; REQ-8, REQ-9.

**Sprint-specific risks:**
- Over-claiming the safety invariant on native realtime (the honesty trap). Detection: review that no code path or doc says native-realtime audio was "blocked before emission". Mitigation: REQ-9 wording in tests + README; this is the sprint's defining constraint.
- Regressing the existing barge-in/`truncateToHeard` behavior. Detection: the existing voice interrupt tests must stay green. Mitigation: keep `heardCharCount`/`truncateAt` semantics identical; only the emission path changes.

**Exit criteria:** incremental voice streaming + honest post-hoc gate demoed; barge-in regression-free; WARMDOWN + HANDOFF written.

---

### Sprint 3 — Cascaded TTFT

**Goal:** make `KuralleRuntimeLLMStream.run` consume `text-delta.delta` and handle the lifecycle so the LiveKit cascaded path begins TTS before the runtime turn completes and `aria_runtime_ttft` drops to first-token latency.

| Story | Description | DoD |
|-------|-------------|------|
| S3-01 | **Adapter lifecycle consumption (C8a, REQ-10).** Update `KuralleRuntimeLLMAdapter.ts:208-219` to push `part.delta` (not `part.text`) into the LiveKit queue, ignore `text-start`/`text-end`, and on `text-cancel` stop forwarding for the current turn. | `aria_runtime_llm_adapter.test` green: chunks carry the per-delta text; `text-cancel` halts forwarding; `recordTtftOnce` fires on the **first** `text-delta`, not at `done`. |
| S3-02 | **TTFT proof (C8b).** Extend the cascaded e2e (`kuralle-livekit-plugin-transport-ws/test/e2e/ws-cascaded-e2e.ts`) to assert the first TTS chunk is produced **before** the runtime emits `turn-end`/`done`. Record before/after `aria_runtime_ttft` for a multi-sentence reply. | E2e asserts first-chunk-before-turn-end; a captured metric artifact shows TTFT dropping from whole-turn to first-token. **Abort criterion (RFC §11):** if TTFT does not improve, stop and re-diagnose — do not paper over. |

**Demo:** cascaded ws e2e run showing first TTS audio chunk timestamped before `turn-end`, plus a before/after `aria_runtime_ttft` number for the same prompt. Artifact under `sprint-3/`.

**Dependencies:** Sprint 1 (lifecycle events on `HarnessStreamPart`).

**Source RFC §:** §7 (C8); REQ-10; §1 success criterion #2; §11 abort.

**Sprint-specific risks:**
- TTFT does not actually improve because something upstream still buffers. Detection: the S3-02 assertion + metric. Mitigation: if red, re-diagnose `speakGated`/`TextDriver` token flow before claiming done (RFC §11 — abort, do not paper over).
- LiveKit SDK chunk shape drift. Detection: adapter test against the pinned `@livekit/agents` version. Mitigation: assert against the installed SDK's `ChatChunk` contract.

**Exit criteria:** first-chunk-before-turn-end proven; TTFT improvement recorded; WARMDOWN + HANDOFF written.

---

### Sprint 4 — Polish + 0.4.0

**Goal:** land the live streaming smoke example, the docs + ADR-0004 amendments (with the native-realtime caveat), and the unified `0.4.0` version bump with a clean publish-together dry run.

| Story | Description | DoD |
|-------|-------------|------|
| S4-01 | **Live smoke example (C10a).** Add a runnable streaming example under `packages/kuralle-core/examples/` that prints the SSE event sequence; wire it so `grep -c '"type":"text-delta"'` > 1 proves incremental streaming. Run it live (not just typecheck) per the repo "untested example = broken example" rule. | Example runs live and emits the multi-delta lifecycle; invocation + output captured in the sprint artifact. |
| S4-02 | **Docs + ADR 0004 (C10b, REQ-9).** Update `apps/docs/`, package READMEs, and `docs/skills/` for the new event shape and the three stream modes; write `docs/adr/0004-streaming-by-default.md` recording the decision and the native-realtime advisory constraint. | Docs reference only the new lifecycle; ADR 0004 present with the decision, the mode table, and the REQ-9 caveat; no doc points at the removed `text-delta.text`. |
| S4-03 | **Unified 0.4.0 (C11, REQ-11).** Bump every package to `0.4.0` (manual-version per the 0.x + `workspace:*` gotcha), write the changeset / CHANGELOG breaking-change note (`part.text` → `part.delta` + lifecycle), and run `pnpm publish -r` **dry run** from a neutral cwd to prove the graph versions together. | All `package.json` at `0.4.0`; CHANGELOG breaking note present; `pnpm publish -r --dry-run` clean; **no actual publish** (human owns the real release + the `main` PR + live smoke). |

**Demo:** the live example invocation + output, the rendered ADR 0004, and the clean `pnpm publish -r --dry-run` log. Artifacts under `sprint-4/`.

**Dependencies:** Sprints 1–3 (the full streaming behavior must exist before it is documented and released).

**Source RFC §:** §8 (C10, C11); REQ-9, REQ-11; §1 success criteria.

**Sprint-specific risks:**
- Piecemeal version bump leaving a dependent pinning the old exact `core` (the monorepo's signature failure). Detection: `pnpm publish -r --dry-run` + a clean `bun install`. Mitigation: bump the **whole** graph in one commit; never publish `core` alone (`CLAUDE.md` Gotchas).
- A `.env` or source map leaking into a tarball. Detection: the dry-run pack contents + the private-leak scan. Mitigation: the existing publish guards; only `.env.example`, no `.map`.

**Exit criteria:** live streaming demoed, docs + ADR landed, `0.4.0` dry-run clean; program complete → hand off to a human PR + real release.

---

## 4. Backlog (deferred to v1.x or v2)

| ID | Item | Earliest | Source RFC § |
|----|------|----------|--------------|
| B-01 | Pure per-chunk stream-transform fast-path for non-blocking output processors (markdown strip, regex PII) — distinct from sentence-mode gating. | post-0.4.0 | §3 (footnote), §5.1 |
| B-02 | Native-realtime audio interception (gate audio before the provider speaks) — requires provider-side control Kuralle does not currently have. | when provider APIs allow | §2.4, §10, REQ-9 |
| B-03 | Sentence segmentation upgrade to a dependency/ML splitter if real transcripts expose boundary failures the regex cannot cover. | as-needed | §12 Q1 |
| B-04 | Aggressive default (`sentence`) for undeclared gate granularity, if field adoption shows `turn` is too conservative in practice. | as-needed | §12 Q2 |
| B-05 | Downstream Studio `SSEChatTransport` migration to the new lifecycle (separate repo; REQ-6 enables it). | downstream | §1, §4.1 |
| B-07 | Investigate whether `Hook.onStreamPart`/`AgentStreamPart` is a dead public surface (no live `ctx.emit` feeds it); remove if confirmed dead. Source: S1-01 / `.understanding/text-delta-consumers.md` O1. | post-0.4.0 | S1-01 |
| B-08 | Live-Gemini validation: does `serverContent.outputTranscription.text` overlap `modelTurn.parts[].text` in `outputAudioTranscription` mode? If so, the voice transcript `TokenSource` would emit duplicate/overlapping deltas — add dedup. Current accumulation semantics preserved as baseline. Source: S2-01 / `.understanding/voicedriver-streaming.md` O1. | when live-Gemini access | S2-01 |
| B-06 | **Fix pre-existing `typecheck:all` drift in test/example files** (discovered at S0-00 baseline, red on `main` @ `925c7bb`): `kuralle-core/test` (5 — `Transition` `"a"` literal + dual-`RunContext` import), `kuralle-engagement/examples/{booking,clothing,pharmacy}` (4/3/2 — TS2722 possibly-undefined). Unrelated to streaming; the "tests/examples never typechecked" CI hole. **Release blocker:** must be green before Sprint 4's `0.4.0` gate is truly clean. | before Sprint 4 release | §9.3 / S0-00 |

---

## 5. Risks tracked across sprints

| Risk | Sprint(s) it materializes | Owner | Mitigation |
|------|---------------------------|-------|------------|
| Sentence mode leaks a blocked sentence (safety invariant breach) | 1, 2 | Manager | Gate before emit; `speakGated.modes` block assertion; hard-stop per RFC §11. |
| Breaking union change leaves a consumer red across a boundary | 1 | Manager | `/code-understand` consumers first; flip + fix all sites in S1-01; `/delegate-review` on Sprint 1. |
| Over-claiming the safety invariant on native realtime audio | 2 | Manager | REQ-9 wording in tests + README; gate is advisory, never "blocked-before-emit". |
| Cascaded TTFT does not actually improve | 3 | Manager | S3-02 first-chunk-before-turn-end assertion + metric; abort + re-diagnose, no paper-over. |
| Piecemeal publish breaks dependents (two copies of `core`) | 4 | Manager | Version the whole graph together; `pnpm publish -r --dry-run`; never publish `core` alone. |
| Baseline not actually green before work starts | 0 | Manager | S0-00 records real `test`/`typecheck:all` counts at branch cut; any red is documented, not assumed away. |

---

## 6. The role of this document

This WBS is the *plan*, not the *prompt*. The program driver lives at [`./SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md). The current sprint pointer lives at [`./STATE.md`](./STATE.md). Templates live under [`./templates/`](./templates/).

When this WBS conflicts with the source RFC, **the RFC (`docs/rfc-streaming-by-default.md`) wins** — amend this document in the same PR.
