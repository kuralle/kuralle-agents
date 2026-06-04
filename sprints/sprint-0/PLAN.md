# Sprint 0 — Plan

**Sprint name:** Primitives
**Sprint goal (one sentence):** Ship `resolveStreamMode`, `SentenceAggregator`, and the `streamGranularity` gate field as additive, unit-tested modules — repo behavior unchanged, `typecheck:all` and `test` green.
**Sprint window:** 2026-06-05 → (single-session)
**Author (main session):** Opus 4.8 (1M) · 2026-06-05

---

## 0. Baseline (S0-00) — recorded before any change

**Branch:** `plan/streaming-by-default` cut from `main` @ `925c7bb` (clean tree after restoring an accidental edit to `sprints/SESSION_KICKOFF_PROMPT.md`).

| Command | Result | Notes |
|---------|--------|-------|
| `bun run build` | ✅ exit 0 | topological build of all packages — green |
| `bun run test` | ✅ exit 0 | full unit suite — **0 fail** across every package |
| `bun run typecheck:all` | ❌ exit 1 | **RED at HEAD** — 4 configs / 14 errors, all pre-existing drift in **test/example files only** (no `src/`) |

> **Honest baseline — the full gate is RED before Sprint 0 touches anything.** `build` and `bun test` are green; `typecheck:all` is not. The failures are pre-existing drift in test/example files, unrelated to streaming. `main` CI does not enforce `typecheck:all` (this red landed on `main` @ `925c7bb`), matching the known "tests/examples never typechecked" CI hole (memory `project_v2_recon_silent_gaps`). `build`/`bun test` don't strict-typecheck these files, so the drift was latent.

**Baseline `typecheck:all` failures (frozen reference — Sprint 0 must add ZERO new failures beyond these):**

| Config | Errors | What |
|--------|--------|------|
| `packages/kuralle-core/test/tsconfig.json` | 5 | `control-model.test.ts:91,131` — `"a"` not assignable to `Transition` (type tightened to `'stay'`-only string); `tool-interim-timeout.test.ts:264` — `RunContext` identity mismatch (`types/run-context` vs `types/session`) |
| `packages/kuralle-engagement/examples/booking/tsconfig.json` | 4 | `booking.test.ts:183,252,253` — TS2722 invoke possibly-`undefined` |
| `packages/kuralle-engagement/examples/clothing/tsconfig.json` | 3 | `clothing.test.ts:191,195,198` — TS2722 invoke possibly-`undefined` |
| `packages/kuralle-engagement/examples/pharmacy/tsconfig.json` | 2 | `pharmacy.test.ts:268,312` — TS2722 invoke possibly-`undefined` |

Full log: `/tmp/tc-baseline-full.log` (captured 2026-06-05). The sweep reports "first 3 errors per config"; per-config totals above are authoritative.

**Sprint-0 gate redefinition (forced by the red baseline, pre-authorized by WBS §1.2/risk row):** each story is green when `bun run typecheck:all` shows **exactly these 4 configs failing and no others** (no NEW config goes red, no new error appears in these 4), AND `tsc --noEmit` is clean on the specific new streaming files (`kuralle-core` `tsconfig.json` — `src/` — stays green), AND the named test suites pass. ICs run a focused proof: build `kuralle-core`, run the named test file, and run `typecheck:all` capturing the failing-config set to compare against this baseline.

**Release blocker (tracked):** see WBS backlog **B-06** — the 4 pre-existing configs MUST be fixed before Sprint 4's `0.4.0` release gate can be *truly* green. Flagged for the human release owner.

---

## 1. Stories

### `S0-01` — `streamGranularity` field on gate interfaces

**Description:** Add `readonly streamGranularity?: 'sentence' | 'turn'` to the two whole-answer gate interfaces actually referenced by the post-turn gate: `OutputProcessor` (`types/processors.ts`) and `ValidationCapability` (`capabilities/ValidationCapability.ts`). Document the default-`turn` semantics in typedoc. Additive only — no consumer changes, no behavior change. (RFC §4.6 / REQ-5.)

> **Naming reconciliation (RFC↔code):** RFC §4.6 names the targets "output `Processor`" and "the `ValidationPolicy` type." Those informal names do **not** exist; the real types are `OutputProcessor` and `ValidationCapability`, and they are exactly what `RunContext.outputProcessors` / `RunContext.validationPolicies` are typed as (`types/run-context.ts:65-67`). No RFC amendment needed — the file paths in §4.6 are correct; only the prose names are loose. The brief instructs the IC to add the field to these two concrete types.

**Acceptance criteria** (priority order):
1. `OutputProcessor` (`types/processors.ts`) gains `readonly streamGranularity?: 'sentence' | 'turn';` with a typedoc line: *"Absent ⇒ `turn` (buffered, safe). Streaming is an explicit opt-in by the gate author."*
2. `ValidationCapability` (`capabilities/ValidationCapability.ts`) gains the same field + same typedoc line.
3. No existing processor/policy implementation needs a change to compile (field is optional). `bun run typecheck:all` green.
4. No runtime behavior change — the field is declared but read by nobody in this story (it is consumed in S0-03).

**Files created/modified:**
- `packages/kuralle-core/src/types/processors.ts` (modify)
- `packages/kuralle-core/src/capabilities/ValidationCapability.ts` (modify)

**Test fixtures:** none beyond a compile-time assertion test (a `.test.ts` that constructs an `OutputProcessor` and a `ValidationCapability` literal with `streamGranularity: 'sentence'` and one without, asserting both typecheck/construct).

**Demo artifact:** `sprints/sprint-0/artifacts/s0-01-typecheck.txt` — `bun run typecheck:all` tail showing green.

### `S0-02` — `SentenceAggregator` + `matchEndOfSentence`

**Description:** Implement `runtime/channels/streaming/SentenceAggregator.ts`: a hand-rolled (no NLP dependency) token→sentence aggregator. `push(tokenText): string[]` returns zero or more completed sentences; `flush(): string | null` returns the trailing partial (or `null` if empty). Boundary detection = terminal punctuation (`. ? !`) + a lookahead/guard that does not split decimals (`$29.99`) or a curated abbreviation list (`Mr. Dr. Mrs. Ms. e.g. i.e. etc.`). Mirrors Pipecat `simple_text_aggregator.py:104-110`. (RFC §4.4 / REQ-2.)

**Acceptance criteria** (priority order):
1. `push` accumulates token fragments and emits a sentence **only** when a terminal-punctuation boundary is confirmed; partial sentences stay buffered across `push` calls (tokens arrive fragmented — e.g. `"Hi th"`, `"ere. How"`).
2. `"Hi there. How are you?"` (fed whole or in fragments) → exactly 2 sentences; `"$29.99 is the price."` → 1 sentence (decimal not split); abbreviations `Mr.`/`Dr.`/`e.g.`/`i.e.` do not split.
3. `flush()` returns the trailing partial sentence (no terminal punctuation) and empties the buffer; second `flush()` on the now-empty buffer returns `null`.
4. Trailing whitespace/empty `push('')` is a no-op (returns `[]`); a boundary immediately followed by more text emits the completed sentence and keeps the remainder buffered.

**Files created/modified:**
- `packages/kuralle-core/src/runtime/channels/streaming/SentenceAggregator.ts` (create)
- `packages/kuralle-core/test/core-channel/aggregator.boundaries.test.ts` (create) — table-driven.

**Test fixtures:** table of `(input tokens[], expected sentences[], expected flush)` rows covering: multi-sentence, decimals, abbreviations, ellipsis (`...`), multi-punctuation (`?!`), fragmented arrival, empty push, flush-then-flush.

**Demo artifact:** `sprints/sprint-0/artifacts/s0-02-aggregator.txt` — filtered `bun run test` output showing `aggregator.boundaries` green.

### `S0-03` — `resolveStreamMode`

**Description:** Implement `runtime/channels/streaming/mode.ts`: `export type StreamMode = 'token' | 'sentence' | 'turn'` and a **pure** `resolveStreamMode(ctx: RunContext, node: ResolvedNode): StreamMode`. Coarsest-wins over (a) `ctx.outputProcessors`, (b) `ctx.validationPolicies` — each contributing `p.streamGranularity ?? 'turn'` — and (c) the node's whole-answer grounding gate via `nodeHasWholeAnswerGroundingGate(ctx, node)`. `token` when nothing is attached. (RFC §4.3 / REQ-4, REQ-5.)

> **Load-bearing design (resolved — see `.understanding/stream-mode-grounding.md`):** `nodeHasWholeAnswerGroundingGate` keys on `node.node.kind === 'reply' && node.node.confidenceGate != null` — the node-level whole-answer **confidence** dependency (`runFlow.ts:227-246`). It does **NOT** key on `node.grounding`, which is pure retrieval/memory scoping (`nodeScope.ts:10`) and must not force buffering (doing so would kill the RFC latency win for every knowledge node). The H6 grounding gate is a `ValidationCapability` and is already counted via the `validationPolicies` arm. `ResolvedNode` carries the node as `node.node` (the `FlowNode` union, `types/channel.ts:6-13`), so the predicate narrows on `kind`.

**Acceptance criteria** (priority order):
1. No gates, no `confidenceGate` ⇒ `'token'`.
2. Exactly one policy/processor declaring `streamGranularity: 'sentence'` (and no `turn` contributors) ⇒ `'sentence'`.
3. Any contributor of `'turn'` ⇒ `'turn'`: (a) a policy/processor with `streamGranularity: 'turn'`, (b) a policy/processor with `streamGranularity` **undeclared** (defaults to `turn` — REQ-5), or (c) a reply node with a `confidenceGate`.
4. Mixed contributors ⇒ coarsest wins (`turn` > `sentence` > `token`).
5. `nodeHasWholeAnswerGroundingGate` returns `false` for a reply node whose only grounding-related field is `node.grounding` (retrieval scope) with no `confidenceGate`; `true` when `confidenceGate` is present; `false` for non-reply nodes (collect/action/decide).
6. Pure function: no I/O, no mutation of `ctx`/`node`, no emit.

**Files created/modified:**
- `packages/kuralle-core/src/runtime/channels/streaming/mode.ts` (create)
- `packages/kuralle-core/test/core-channel/mode.test.ts` (create)

**Test fixtures:** minimal `RunContext`/`ResolvedNode` stub builders (reuse existing test helpers in `test/helpers` if present; otherwise inline minimal literals). Cases: empty; one `sentence` policy; one `turn` policy; one undeclared policy; one `sentence` processor + one `turn` policy (→turn); reply node with `confidenceGate` + zero gates (→turn); reply node with `grounding` only (→token); collect node with `confidenceGate`-shaped sibling absent (→token).

**Demo artifact:** `sprints/sprint-0/artifacts/s0-03-mode.txt` — filtered `bun run test` showing `mode.test` green.

---

## 2. Universal DoD checklist (per story)

- [ ] `bun run typecheck:all` green (the full gate); `bun run test` green for the named suites.
- [ ] Behavioral coverage: ≥1 happy-path + ≥1 failure/edge-path test per public surface.
- [ ] Proof JSON written (`.handoff/proof-s0-NN.json`); manager proceed evidence = **PROCEED**.
- [ ] Demo artifact present under `sprints/sprint-0/artifacts/`.
- [ ] No `--no-verify`, no `@ts-ignore`/`as any`, no silent catch, no compat shim.
- [ ] Additive only — no behavior change to existing flow/voice/extraction suites (they stay green).

---

## 3. Test plan

| Story | Layer | Test type | Fixtures |
|-------|-------|-----------|----------|
| S0-01 | types | compile-time construction test | literal `OutputProcessor` / `ValidationCapability` with & without the field |
| S0-02 | unit | table-driven boundary tests | sentences / decimals / abbreviations / ellipsis / fragments / flush |
| S0-03 | unit | pure-function truth table | gate-config + node permutations |

**Will NOT test this sprint (safe because additive, no consumer wired yet):**
- `speakGated` emission (Sprint 1 — module doesn't exist yet).
- Driver integration / event lifecycle (Sprint 1+).
- The field being *read* by `applyPostTurnPolicies` (it isn't — consumed only by `resolveStreamMode`, which is itself not yet called by any driver until Sprint 1).

---

## 4. Demo plan

**Demo:** A single offline run — `bun run test` filtered to `aggregator.boundaries` + `mode.test` showing both suites green, plus a one-line `bun run typecheck:all` clean confirmation. No runtime behavior changed, proven by the existing flow/voice/extraction suites still passing in the same `bun run test`. Artifacts captured per story under `sprints/sprint-0/artifacts/`.

---

## 5. Risks specific to this sprint

| Risk | Detection signal | Mitigation |
|------|------------------|------------|
| `matchEndOfSentence` over/under-splits real transcripts | table-driven test rows fail | lookahead before declaring a boundary (Pipecat pattern); real-transcript failures are backlog B-03, not a Sprint-0 blocker |
| `resolveStreamMode` keys on the wrong grounding signal | `mode.test` ac#5 (grounding-only node ⇒ token) | resolved via `.understanding/stream-mode-grounding.md`: key on `confidenceGate`, not `node.grounding` |
| Baseline assumed green but isn't | S0-00 records real counts before any change | document any pre-existing red; assert "no new failures", not "zero failures" |
| Field added to wrong type (RFC's loose `Processor`/`ValidationPolicy` names) | `resolveStreamMode` can't read `ctx.{outputProcessors,validationPolicies}[].streamGranularity` | add to `OutputProcessor` + `ValidationCapability` (the types `RunContext` actually uses) |

---

## 6. Open questions (surfaced before work starts)

1. **`nodeHasWholeAnswerGroundingGate` is largely subsumed by the `validationPolicies` term in today's code** (both H6 grounding and `confidenceGate`-derived confidence flow from validation policies — `.understanding/stream-mode-grounding.md`). **Resolution (manager):** keep the predicate keyed on `confidenceGate` for RFC-faithfulness and forward-safety; it is harmless and node-explicit. No RFC amendment — §4.3/§7 left the predicate body unspecified; S0-03 specifies it. Flag for Phase B / Sprint-1 `/delegate-review` to confirm.
2. **S0-01 compile-test placement.** A pure type-level test adds a near-empty `.test.ts`. **Resolution:** include it (DoD requires a behavioral test per public surface; for a type-only change the "behavior" is "the literal with/without the field constructs and typechecks"). Keep it tiny.
