# Review (r1, sandwich) — Sprint 1 "Protocol flip + text path"

> **Reviewer (main session):** Opus 4.8 (1M) · 2026-06-05.
> **Diff under review:** `main..HEAD` on `plan/streaming-by-default` — `c1c41fe` (S1-01), `245f2cc` (S1-02), `738d3e2` (S1-03), `0a65cad` (S1-fix).
> **Adversarial pass:** `/delegate-review` → codex (gpt-5.5, high reasoning), verdict **not-ready** with 4 findings; all resolved in `[S1-fix]`. Briefs `.handoff/brief-stream-s1-0{1,2,3}.md` + `brief-stream-s1-review.md`; proceed `proceed-s1-0{1,2,3}.md`.

The sandwich: strengths, the adversarial findings + their fix, constructive close.

---

## 1. Strengths

- **The breaking flip landed atomically and completely** — `c1c41fe` flips all three unions (`stream.ts:10-13`, `voice.ts:266-269`, `processors.ts:93-96`) and migrates ~70 producer/consumer/test/example sites in one commit, with `typecheck:all` showing **zero new failures** over the frozen baseline and the **full `test` suite green**. The self-enforcing gate (no-new-typecheck + full-test) made completeness provable rather than asserted.
- **`speakGated` gates before emit, structurally** (`speakGated.ts:87-103`): a sentence reaches `ctx.emit` only via `emitCleared`, called only after `runGate` returns not-blocked. The hard invariant (RFC §11) holds by construction, and the test asserts the blocked text is absent as exact-match AND substring (`speakGated.modes.test.ts:162-163`).
- **`TextDriver` preserves the tool-call loop while streaming** (`TextDriver.ts:66-143`): the step loop moved verbatim into a `TokenSource` generator that yields deltas; `turn` mode reproduces the old buffered behavior exactly; REQ-1 is proven with a real multi-delta streaming stub (`textdriver.test.ts:211-237`), not a faked one.
- **The pre-brief consumer map paid off** — `.understanding/text-delta-consumers.md` (86 files, manager-verified) turned a terrifying blast radius into a checklist; the migration followed it and the gate caught what it missed.
- **The `/delegate-review` was load-bearing, not ceremony** — codex found 4 real defects the proceed-evidence pass missed, including one (the `.js/.mjs` migration gap) that the manager's own `--include=*.ts` grep-clean was blind to.

---

## 2. Critique (adversarial findings — all resolved in `[S1-fix]` `0a65cad`)

### 2.3 Majors (found by codex, fixed + manager-verified)

#### M1. Sentence-mode whitespace loss (R-01 / F-01)
- **Where:** `SentenceAggregator.ts` (`trimStart()` on emitted sentences).
- **What:** `sentence`-mode `text-delta`s concatenated to `"Hi there.How are you?"` — the inter-sentence space was dropped. Latent (no default gate selects sentence mode) but a real correctness bug; the S0-02 test even asserted the lossy form.
- **Fix (verified):** aggregator preserves inter-sentence whitespace; `aggregator.boundaries.test.ts:84` now asserts `sentences.join('') + tail === original`; hard-invariant test stayed green.

#### M2. `.js/.mjs` consumers not migrated (R-03 / F-03)
- **Where:** `kuralle-hono-server/test/{stream-filter.test.js, stream-filter-adversarial.test.js, e2e-leak-test.mjs, e2e-hono-smoke.mjs}`.
- **What:** the `.ts`-only grep-clean missed these — old-shape `{type:'text-delta',text}` survived, risking vacuous tests (REQ-11 "no old shape in packages/**").
- **Fix (verified):** all migrated to `{id,delta}`; grep-clean now empty across `*.ts`/`*.js`/`*.mjs`; tests assert on `.delta` and pass.

#### M3. Cascaded adapter ignored `text-cancel` (R-02 / F-02)
- **Where:** `KuralleRuntimeLLMAdapter.ts` run loop.
- **What:** forwarded canceled-turn deltas to LiveKit TTS (no `text-cancel` handling). Latent (cancel only on sentence-mode block) but a correctness gap introduced by the new protocol.
- **Fix (verified):** tracks `canceledTurnIds`, skips canceled turns, ignores `text-start`/`text-end`; adapter test added. True per-delta TTFT streaming correctly **deferred to Sprint 3** (not implemented here).

### 2.3b Minor (fixed)

#### m1. CF `StreamAdapter` lifecycle handling (R-04 / F-04)
- **Where:** `kuralle-cf-agent/src/StreamAdapter.ts`.
- **Fix (verified):** added `text-start`/`text-end`/`text-cancel` cases (`:85,88,92`); new `StreamAdapter.test.ts` covers multi-delta + partial-cancel-then-safe; `package.json` test script extended to run `src/__tests__` (legitimate — wires the new test into the suite).

### 2.4 Nits / carried
- Proof-JSON hygiene from the cursor IC was poor on S0-03 + S1-01 (malformed `commands_run`/claim schema → verifier crashes); manager independently re-verified every claim and repaired the proofs. S1-02/03/fix proofs were well-formed. **Carry:** independent manager re-verification is the real gate; proofs are corroboration.
- The `SentenceAggregator` `MIN_WORDS...=3` heuristic (Sprint-0 m1) still stands — re-evaluate when sentence mode gets a real default gate.

---

## 3. Cross-cutting concerns

- **Hard invariant (RFC §11):** verified directly — no blocked-sentence leak in `speakGated`; cascaded/CF adapters now discard canceled turns; no path forwards blocked content to TTS. (Cleared sentences forwarded before a cancel are by definition safe.)
- **REQ-7 (one start/end per turn):** single `started` latch in `speakGated`; one-shot producers emit self-contained trios with fresh ids; tests count exactly one start/end.
- **REQ-12 (extraction silent):** `extractionTurn.ts` untouched across the sprint; test asserts zero text lifecycle events from `runExtraction`.
- **No suppression anywhere:** `@ts-ignore`/`as any`/`--no-verify`/compat-alias count = 0 across all four commits.
- **Type-safety:** test fixtures use real `createRunContext`/helpers, no `as any`.
- **RFC sync:** §4.2.1 + REQ-6 amended for `AgentStreamPart` (O1); B-07 logged (possible dead `Hook.onStreamPart` surface — investigate post-0.4.0).

---

## 4. Constructive close

Sprint 1 did the scariest thing in the program — a breaking protocol flip across 8 packages — and did it cleanly: atomic, no-new-typecheck-failures, full-suite-green, zero suppression. The adversarial review earned its place by catching four latent defects (especially the `.js/.mjs` blind spot), all now fixed and re-verified. Start Sprint 2 from `speakGated` (already the shared path) — `VoiceDriver` plugs into it the same way `TextDriver` did, with the REQ-9 honesty constraint as the new twist.

---

## 5. Verdict

- [x] **Approve with minor fixes — fixes applied.** Codex's 4 findings (M1–M3, m1) all resolved in `[S1-fix]` `0a65cad` and independently re-verified by the manager (build 0, full test green, guard no-new-failures, grep-clean ts+js+mjs, hard invariant intact). No remaining blockers or majors.

**Path forward:** close Sprint 1 (WARMDOWN + HANDOFF + STATE → Sprint 2).
