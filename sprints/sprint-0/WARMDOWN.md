# Sprint 0 — Warm-down

> **Author (main session):** Opus 4.8 (1M) · 2026-06-05.
> **Sprint window:** 2026-06-05 (single session).
> **Outcome:** Goal achieved — the three streaming primitives shipped as additive, fully-tested modules with zero behavior change; repo `build` + `test` green, `typecheck:all` red only on the pre-existing baseline drift (no new failures).

---

## 1. Goal recap

**Sprint goal (from WBS):** Ship `resolveStreamMode`, `SentenceAggregator`, and the `streamGranularity` gate field as additive, unit-tested modules — repo behavior unchanged, `typecheck:all` and `test` green.

**Did we hit it?** **Yes**, with one honest caveat on the gate. All three primitives shipped, each unit-tested (happy + edge paths), purely additive (no production path reads them yet). `bun run test` is green (0 fail) and `bun run build` is green. The `typecheck:all` part of the goal could not be taken literally because the gate is **RED at HEAD** for reasons that predate this sprint (test/example drift). We redefined the per-story gate to "zero NEW failures over the frozen baseline," proved it with a guard script per story, and tracked the pre-existing red as release blocker B-06. So: behavior unchanged ✓, tests green ✓, typecheck:all "no new failures" ✓ (not "all green" — that is B-06's job before Sprint 4).

---

## 2. Stories shipped

| Story | Status | Commit | Demo | Notes |
|-------|--------|--------|------|-------|
| S0-00 | Done | `ca1ff11` | PLAN §0 baseline table | Branch cut; baseline recorded honestly (typecheck:all RED). |
| S0-01 | Done | `19f3505` | `artifacts/s0-01-typecheck-guard.txt` | `streamGranularity?` on `OutputProcessor` + `ValidationCapability`. |
| S0-02 | Done | `3ff2231` | `artifacts/s0-02-aggregator.txt` (12 pass) | `SentenceAggregator` + `matchEndOfSentence`, hand-rolled, no NLP dep. |
| S0-03 | Done | `4d103f4` + `31d5daa` (fix) | `artifacts/s0-03-mode.txt` (10 pass) | `resolveStreamMode`, pure, coarsest-wins; `[S0-03-fix]` removed a stray root file. |

No stories slipped.

---

## 3. What's working

- **`resolveStreamMode`** (`runtime/channels/streaming/mode.ts`) — pure coarsest-wins selection; 10/10 truth-table tests green (`mode.test.ts`), including the grounding-vs-confidenceGate distinction.
- **`SentenceAggregator`** (`runtime/channels/streaming/SentenceAggregator.ts`) — splits multi-sentence text, guards decimals (`$29.99`) and abbreviations (`Dr.`, `e.g.`), handles ellipsis/multi-punctuation, fragmented arrival, and `flush()`; 12/12 tests green.
- **`streamGranularity?`** field present on both gate interfaces with default-`turn` typedoc; existing implementations compile untouched.
- **The no-new-failures guard** (`artifacts/guard-stream-s0-0{1,2,3}.sh`) — a reusable, branch-relative check that freezes the baseline and fails on any new `typecheck:all` red. Independently re-run by the manager for S0-03.

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-0-01 | `typecheck:all` RED at baseline — 4 configs/14 errors of pre-existing test/example drift (no `src/`). Unrelated to streaming. | major | Sprint 4 (or earlier) | WBS **B-06** (release blocker) |
| KI-0-02 | `SentenceAggregator` `MIN_WORDS_TO_CONFIRM_PERIOD_AT_TOKEN_END=3` heuristic — short final sentence surfaces only via `flush()`. Benign (Sprint 1 `speakGated` gates the flush tail) but undocumented complexity. | minor | Sprint 1 | review-sprint.md m1 |
| KI-0-03 | Transient `typecheck:all` flake — one S0-03 run flagged `cf-voice-realtime-gemini-flow`; manager re-run baseline-only. Likely sweep concurrency race. | minor | watch Sprints 1–3 | review-sprint.md §3 |
| KI-0-04 | IC scope-creep: ICs emitted `*-implementation-notes.md` at repo root (1 committed → fixed, 2 untracked → deleted). | nit | future briefs | review-sprint.md m2 |

---

## 5. Decisions made

- **Decision:** `nodeHasWholeAnswerGroundingGate(ctx, node)` keys on `node.node.kind==='reply' && confidenceGate != null`, NOT on `node.grounding`. **Rationale:** `node.grounding` is retrieval scoping (`nodeScope.ts:10`) and must not force buffering; the H6 grounding gate is a `ValidationCapability` already counted via the `validationPolicies` arm; `confidenceGate` is the genuine node-level whole-answer dependency (`runFlow.ts:227-246`). **Source:** [`.understanding/stream-mode-grounding.md`](../../.understanding/stream-mode-grounding.md). **RFC amendment:** none — RFC §4.3/§7 left the predicate body unspecified.
- **Decision:** add `streamGranularity?` to `OutputProcessor` + `ValidationCapability` (not the RFC's loose names "Processor"/"ValidationPolicy"). **Rationale:** those are the concrete types `RunContext.{outputProcessors,validationPolicies}` resolve to. **Source:** PLAN §S0-01 note. **RFC amendment:** none (file paths in §4.6 were correct).
- **Decision:** per-story gate = "zero new `typecheck:all` failures over a frozen baseline" rather than "all green." **Rationale:** the gate is RED at HEAD for pre-existing reasons; WBS §1.2/risk row pre-authorized documenting red and asserting no-new-failures. **Source:** PLAN §0. **RFC amendment:** none.

---

## 6. Wiki / RFC amendments this sprint

No RFC amendments this sprint. WBS amended once: added backlog **B-06** (the pre-existing `typecheck:all` drift, release blocker for Sprint 4).

---

## 7. Metrics

- **Tests added:** 12 (`aggregator.boundaries`) + 10 (`mode`) + field-construction test (`stream-granularity-field`) ≈ 23+ new behavioral tests.
- **Src surface added:** 2 modules (`mode.ts` 19 LOC, `SentenceAggregator.ts` 197 LOC) + 2 interface fields.
- **Behavior change:** none (additive primitives, no production consumer wired).
- **Baseline:** `build` ✅, `test` ✅ (0 fail), `typecheck:all` ❌ (4 configs/14 errors, frozen; 0 new).

---

## 8. Backlog updates

**Added:**
- B-06: fix pre-existing `typecheck:all` drift in test/example files (release blocker before Sprint 4).

**Promoted into a future sprint:** none.
**Removed:** none.

---

## 9. Retrospective

### Keep
The pre-brief `/code-understand` on the grounding gate paid off directly: the S0-03 IC implemented the correct `confidenceGate` predicate first time because the brief handed it the resolved decision + file:line evidence. Briefing the load-bearing ambiguity *before* delegating beats discovering it in review.

### Change
The IC briefs didn't forbid scratch/notes files, so all three ICs littered the repo root; one even committed it. Proof-JSON schema also drifted (S0-03 used `claim_id`/no `type`). Next sprint's briefs must (a) explicitly forbid any file outside the listed paths, and (b) quote the exact `claims[]` schema fields.

### Try next
For Sprint 1's breaking flip, run `/code-understand` on the `HarnessStreamPart`/voice-union *consumers* before S1-01 (as the WBS already recommends) — the blast radius is the whole point, and a consumer map up front will make the mechanical-fix sweep deterministic.

---

## 10. Pointers for the next sprint

- **Files to read first (Sprint 1):** `types/stream.ts`, `types/voice.ts` (the unions to flip), `runtime/channels/TextDriver.ts:58-147` (the accumulate-then-emit block to replace), `Runtime.ts:131,246` (mechanical emit sites), `KuralleRuntimeLLMAdapter.ts:208-219`. The Sprint-0 primitives to wire: `runtime/channels/streaming/{mode,SentenceAggregator}.ts`.
- **Traps:** (1) `typecheck:all` is the blast-radius gate for the breaking union flip but it is RED at baseline — use the same frozen-baseline guard pattern (diff the FAIL-config set), not "exit 0". (2) Stale-dist: rebuild `kuralle-core` before anything downstream consumes the new event shape. (3) The `SentenceAggregator` short-final-sentence heuristic (KI-0-02) — exercise it in `speakGated` and decide keep-or-remove.
- **Open RFC amendments in flight:** none.
- **Open blockers for Sprint 1:** none (B-06 is a Sprint-4 release blocker, not a Sprint-1 blocker).

---

## 11. Closeout

- [x] All shipped stories committed atomically on `plan/streaming-by-default`.
- [x] Phase B review done (`review-sprint.md`) — Approve, no fix pass needed.
- [x] Backlog delta added to `sprints/WBS.md §4` (B-06).
- [x] `sprints/sprint-0/HANDOFF.md` written.
- [x] `sprints/STATE.md` updated with Sprint 1 pointer + load-bearing reading.
- [x] Demo artifacts under `sprints/sprint-0/artifacts/`.

Sprint 0 is closed.
