# Review (r1, sandwich) — Sprint 0 "Primitives"

> **Reviewer (main session):** Opus 4.8 (1M) · 2026-06-05.
> **Diff under review:** local branch `plan/streaming-by-default`, `main..HEAD` (commits `ca1ff11`, `19f3505`, `3ff2231`, `4d103f4`, `31d5daa`).
> **Briefs:** `.handoff/brief-stream-s0-0{1,2,3}.md` · **Proceed:** `sprints/sprint-0/proceed-s0-0{1,2,3}.md`
> **Scope reviewed:** full sprint diff (850 insertions, additive only), all three IC briefs, all three proceed artifacts.

This is the Phase B manager sandwich review (after every story reached PROCEED). `/delegate-review` was optional for Sprint 0 (recommended only for Sprints 1 & 3) and not run.

---

## 1. Strengths

- **`resolveStreamMode` is a faithful, minimal translation of RFC §4.3/§7** at `runtime/channels/streaming/mode.ts:10-19` — coarsest-wins over `outputProcessors`/`validationPolicies` with `?? 'turn'` defaulting (REQ-5), 19 lines, pure. It is byte-for-byte the RFC blueprint with the one undefined piece (`nodeHasWholeAnswerGroundingGate`) filled in correctly.
- **The grounding-gate predicate keys on the right signal** at `mode.ts:6-8`: `node.node.kind === 'reply' && node.node.confidenceGate != null`. This matches the manager's pre-brief analysis (`.understanding/stream-mode-grounding.md`) — `confidenceGate` is the real node-level whole-answer dependency (`runFlow.ts:227-246`), and it deliberately does **not** key on `node.grounding` (retrieval scope, `nodeScope.ts:10`), which would have needlessly buffered every knowledge node and defeated the RFC's entire latency goal.
- **`matchEndOfSentence` lookahead correctly defers across token fragments** at `SentenceAggregator.ts:151-186` — a boundary is held until the next non-whitespace token (or `flush`) confirms it, so `push('there.')`→`[]` then `push(' How')`→`['Hi there.']` (test `aggregator.boundaries.test.ts:97-103`). This is the Pipecat-style lookahead REQ-2 calls for, hand-rolled with zero NLP dependency (RFC §5.2/Q1 honored).
- **The "no-new-`typecheck:all`-failures" guard** (`artifacts/guard-stream-s0-0{1,2,3}.sh`) is the right engineering response to a red baseline: it freezes the 4 pre-existing failing configs and fails the story on *any* new red, rather than papering over the baseline or demanding an unattainable green. Each story's guard ran clean.
- **`mode.test.ts:17-19,22-32` builds a real `RunContext`** via `createRunContext` + `core-durable/helpers` instead of `as any` — type-safe test fixtures, exactly as the brief demanded.

---

## 2. Critique

### 2.1 Blockers
None.

### 2.2 Majors
None.

### 2.3 Minors

#### m1. Undocumented word-count heuristic in `SentenceAggregator`
- **Where:** `SentenceAggregator.ts:17,167-175` (`MIN_WORDS_TO_CONFIRM_PERIOD_AT_TOKEN_END = 3`).
- **What:** A short (<3-word) sentence ending in `.` exactly at buffer-end is held as `pendingPeriodConfirm` until the next token or `flush()`. This is behavior beyond RFC §4.4 (which specifies only punctuation + decimal/abbreviation lookahead).
- **Why it's a minor not a blocker:** benign for the only future consumer — Sprint 1 `speakGated` gates the `flush()` tail with `final=true`, so a short final sentence is still emitted and gated; nothing is lost or leaked. But it is accidental complexity (CLAUDE.md §2) and an unstated rule.
- **Proposed fix (Sprint 1):** when `speakGated` consumes the aggregator, either (a) remove the heuristic if end-to-end tests show it's unnecessary, or (b) keep it and add an explicit test asserting "short final sentence surfaces via `flush()`", and document the rule in the class typedoc.

#### m2. IC scope-creep: stray repo-root notes files
- **Where:** repo root — `stream-s0-03-implementation-notes.md` (committed; removed in `[S0-03-fix]` `31d5daa`), plus untracked `stream-s0-01/02-implementation-notes.md` (deleted by manager).
- **What:** all three ICs emitted an unrequested notes file at the repo root, outside the brief file list (violates STORY-BRIEF §6 anti-scope).
- **Proposed fix:** future briefs add an explicit "do not create any file outside the listed paths, including notes/scratch files at repo root" line. No code impact.

### 2.4 Nits
- Proof-JSON hygiene: S0-03's proof used `claim_id`/omitted `type` (crashed the verifier until manager-repaired). Future briefs could quote the exact `claims[]` schema. (S0-01/02 proofs were well-formed.)
- `SentenceAggregator` is 197 lines vs an expected ~80; most of the excess is the lookahead state machine (`pendingPeriodConfirm`/`needsLookahead`) that m1's heuristic drives. Resolving m1 should shrink it.

---

## 3. Cross-cutting concerns

- **Behavior-unchanged invariant (Sprint 0's defining goal):** verified. The new field is read by no runtime path; `SentenceAggregator` and `resolveStreamMode` are imported by no production code yet (both are leaf modules). Full `bun run test` is green (0 fail) at this HEAD — the existing flow/voice/extraction suites are untouched. Zero behavior change, as REQ-style additive primitives require.
- **Type-safety holes:** none. No `any`/`as any`/`as unknown as` in any src or test file (grep-confirmed per story).
- **Dependency surface:** zero new deps (RFC §5.2 / Q1). `SentenceAggregator` is hand-rolled regex.
- **Public-surface ↔ RFC:** the two interface fields, `StreamMode`, the `SentenceAggregator` signature, and the `resolveStreamMode` signature all match RFC §4.3/4.4/4.6. The only RFC↔code reconciliations — `Processor`→`OutputProcessor`, `ValidationPolicy`→`ValidationCapability`, and the unspecified `nodeHasWholeAnswerGroundingGate` body — are documented (PLAN §S0-01 note, `.understanding/`), and per WBS §6 do not require an RFC amendment (the file paths in §4.6 were correct; the predicate body was left to the implementer).
- **Baseline honesty / release risk:** `typecheck:all` is RED at baseline (4 configs/14 errors, pre-existing test/example drift). Tracked as **B-06**, a Sprint-4 release blocker. Sprint 0 added zero new failures. This must be resolved before the `0.4.0` gate in Sprint 4 can be truly green — flagged for the human release owner.
- **Transient flake watch:** S0-03 IC reported one intermediate `typecheck:all` run flagging `cf-voice-realtime-gemini-flow`; manager re-run was baseline-only. Likely a concurrent-build race in the 62-config sweep, not a real regression. Worth watching in Sprints 1–3 (which build more under load).

---

## 4. Constructive close

There is nothing to fix before this sprint closes — no blockers, no majors, and the one scope issue (m2) is already remediated in `[S0-03-fix]`. The two minors (m1 heuristic, m2 brief-tightening) are correctly deferred: m1 becomes testable end-to-end only once Sprint 1's `speakGated` consumes the aggregator, so resolving it now would be premature. Carry m1 and the nits into the Sprint 1 brief for `speakGated`/`TextDriver`, where the aggregator's emission semantics get exercised for real.

---

## 5. Verdict

- [x] **Approve with minor fixes.** No blockers or majors. The one scope violation (m2) is resolved in `[S0-03-fix]`; m1 + nits are deferred to Sprint 1 with explicit carry-over notes. No additional `[S0-fix]` commit required — the sprint diff is clean and additive, the full test suite is green, and `typecheck:all` shows zero new failures over the frozen baseline.

**Path forward:** close Sprint 0 (WARMDOWN + HANDOFF + STATE update), then open Sprint 1 (the breaking protocol flip — `/delegate-review` recommended there).
