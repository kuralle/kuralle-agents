# Sprint 1 — Plan

**Sprint name:** Protocol flip + text path
**Sprint goal (one sentence):** Replace the single-shot `text-delta` with the `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle across both unions and route `TextDriver` through `speakGated`, so an ungated text reply emits more than one delta before turn-end while a grounded node still buffers — `typecheck:all` (no new failures) and `test` green at close.
**Sprint window:** 2026-06-05 (continued session)
**Author (main session):** Opus 4.8 (1M) · 2026-06-05

**Load-bearing input:** `.understanding/text-delta-consumers.md` — exhaustive 86-file producer/consumer/test/example map (pi explorer, manager-spot-verified). The S1-01 checklist is that table. **Line numbers in the map drifted slightly** (e.g. TextDriver emit is `:42`/`:143`, not `:58`/`:136`; stream.ts member is `:10`) — ICs must **grep the exact sites**, not trust hardcoded lines; the table is the *completeness checklist*.

---

## 0. Open-question resolutions (manager decisions — bind the briefs)

From `.understanding/open-text-delta-consumers.md`:

- **O1 — `AgentStreamPart` (`types/processors.ts:92`) IS in scope.** It is a separate public hook contract (`Hook.onStreamPart`, `runtime.ts:30`), NOT on the live `ctx.emit` path — but it carries the same `{type:'text-delta',text}` shape. Leaving it old-shape while everything else moves to `{id,delta}` is exactly the dual-shape inconsistency **REQ-11 forbids**. **Decision: flip `AgentStreamPart` to the four-variant lifecycle in S1-01**, and **amend the RFC** §4.1/§4.2 + REQ-6 to name `types/processors.ts` `AgentStreamPart` as the third in-scope union (DoD #4 requires the amendment in the same change). Note for backlog: `Hook.onStreamPart`/`AgentStreamPart` may be a dead public surface (no live emit feeds it) — flag as **B-07**, do not remove this sprint (pre-existing; surgical rule).
- **O2 — `streamFilter.ts` `SAFE_EVENT_TYPES` gains the lifecycle variants.** A `safe`-mode client receiving `text-delta` without `text-start`/`text-end` framing is broken. **Decision: add `'text-start'`, `'text-end'`, `'text-cancel'`** to the set (keep `'text-delta'`). In-repo consumer migration; no RFC amendment.
- **O3 — Cascaded adapter is compile-only in S1-01.** WBS-settled: change `.text`→`.delta`, ensure the filter does not throw on `text-start`/`text-end`/`text-cancel`, keep today's buffered behavior. True streaming + TTFT = **Sprint 3**.
- **O4 — One-shot messages each emit a self-contained lifecycle trio with a fresh `uuid`.** `onInterim` (`Runtime.ts:131`), degraded (`:246`), pre-turn blocked (`TextDriver`/`VoiceDriver`), collect ask (`collectUntilComplete`), digression (`collectDigression`), degrade fallback — each emits `text-start{newId}` → `text-delta{newId,delta:msg}` → `text-end{newId}`. This honors REQ-7 ("one start/end pair per *speaking turn*") — each one-shot message is its own short speaking turn — and matches RFC §7's prescription for a pre-emit blocked message. No RFC amendment.

---

## 1. Stories

### `S1-01` — Breaking lifecycle flip + migrate ALL in-repo consumers (C1 + compile-critical C9)

**Description:** In `types/stream.ts`, `types/voice.ts`, **and** `types/processors.ts` (`AgentStreamPart`, per O1), remove `{ type: 'text-delta'; text: string }` and add the four lifecycle variants (`text-start{id}` / `text-delta{id,delta}` / `text-end{id}` / `text-cancel{id,reason}`). Then migrate **every** in-repo producer and consumer so the repo compiles and tests pass — this is one atomic change (the repo does not compile until all ~70 sites are migrated; there is no green intermediate commit, so this is a single commit). Producers emit the **one-shot lifecycle trio** (O4); `TextDriver`/`VoiceDriver`/cascaded-adapter are flipped to the new shape but **keep current buffered behavior** (true streaming lands in S1-03/Sprint 2/3). Amend the RFC for O1.

**Acceptance criteria** (priority order):
1. No `{ type: 'text-delta'; text: ... }` (the `text` field) remains anywhere in `packages/**` (grep-clean); all three unions expose only the four lifecycle variants. No compat alias, no dual-emit (REQ-6, REQ-11).
2. Every PRODUCER (map P1–P12) emits a complete lifecycle: a one-shot message = `text-start{id}`→`text-delta{id,delta}`→`text-end{id}` with a fresh `id` (O4); `id` via `crypto.randomUUID()`.
3. Every CONSUMER (map C1–C13) reads `part.delta` (not `.text`) and tolerates `text-start`/`text-end`/`text-cancel` (ignore or handle, never throw). `SAFE_EVENT_TYPES` includes the lifecycle variants (O2).
4. Cascaded adapter (D1) compile-only: `.text`→`.delta`, filter tolerant of lifecycle events, buffered behavior unchanged (O3).
5. All compile-critical tests (map T1–T41) updated to the new shape; **`bun run typecheck:all` shows no NEW failures over the frozen baseline** (4 configs) and **`bun run test` is green**. The full test suite green is the completeness backstop — a missed site fails this.
6. `extractionTurn` still emits **zero** text lifecycle events (REQ-12 — verify it's untouched; it only emits `error`).
7. RFC amended (§4.1/§4.2 + REQ-6) to name `AgentStreamPart` as the third in-scope union (O1); WBS B-07 added (possible dead hook surface). Examples (map E1–E22) migrated.
8. Atomic commit `[S1-01] breaking text-delta lifecycle flip + migrate all consumers`.

**Files:** the three unions + all P/C/D/T/E rows in `.understanding/text-delta-consumers.md` + `docs/rfc-streaming-by-default.md` (amendment) + `sprints/WBS.md` (B-07). **Grep the exact emit/read sites; the map is the checklist.**

**Demo artifact:** `sprints/sprint-1/artifacts/s1-01-grep-clean.txt` — `grep -rn "type: 'text-delta', text" packages --include=*.ts | grep -v /dist/` returning empty, plus the no-new-failures guard output.

### `S1-02` — `speakGated` + `TokenSource` (C5)

**Description:** Implement `runtime/channels/streaming/speakGated.ts` per RFC §4.5/§6/§7: the single shared gated emitter over a `TokenSource` (async-iterable of `{delta}`). `token` mode emits each delta live; `sentence` mode aggregates via `SentenceAggregator`, gates each completed sentence, emits cleared ones (block ⇒ `text-cancel` + fresh safe-message lifecycle, blocked sentence text NEVER emitted); `turn` mode accumulates, gates once, emits buffered. Exactly one `text-start`/`text-end` per turn (REQ-7). Source error ⇒ emit `{type:'error'}` then `text-cancel` if started.

**Acceptance criteria** (priority order):
1. `speakGated.modes` test green for all three modes; **the hard invariant test asserts the blocked sentence's text is ABSENT from the captured event stream** (not merely that a safe message appears) — RFC §11 abort if breached.
2. Exactly one `text-start`/`text-end` pair per turn asserted (single `started` latch, REQ-7); all deltas share the turn `id`.
3. Sentence-mode block ⇒ `text-cancel{id}` (if started) then a fresh-id safe-message lifecycle; turn-mode (grounding) block ⇒ buffered safe message, no leaked content.
4. Source-thrown error ⇒ `{type:'error'}` emitted then lifecycle closed with `text-cancel` if a `text-start` was emitted.
5. `typecheck:all` no-new-failures + `test` green. Pure of any driver coupling (drivers wire it in S1-03).

**Files:** `runtime/channels/streaming/speakGated.ts` (+ `TokenSource` type), `test/core-channel/speakGated.modes.test.ts`.

**Demo artifact:** `sprints/sprint-1/artifacts/s1-02-speakgated.txt` — test output incl. the blocked-sentence-absent assertion.

### `S1-03` — `TextDriver` on the shared path (C6)

**Description:** Replace `TextDriver`'s accumulate-then-emit block with a `TokenSource` over `streamText().fullStream` feeding `speakGated`, with `resolveStreamMode(ctx,node)` selecting the mode and `applyPostTurnPolicies` as `runGate`. Preserve the tool-call step loop. `runExtraction` untouched (REQ-12).

**Acceptance criteria** (priority order):
1. Ungated-reply integration test asserts **>1** `text-delta` for a multi-token reply AND the first arrives **before** `turn-end` (REQ-1).
2. Grounded-node (turn-mode) test asserts buffered emit (one message) + no blocked content (REQ-3).
3. Extraction test asserts **zero** text lifecycle events (REQ-12).
4. Tool-call step loop preserved (existing tool tests green).
5. `typecheck:all` no-new-failures + full `test` green.

**Files:** `runtime/channels/TextDriver.ts`, its tests.

**Demo artifact:** `sprints/sprint-1/artifacts/s1-03-multidelta.txt` — captured SSE/event sequence showing `text-start`→multiple `text-delta{id,delta}`→`text-end` for an ungated node; `grep -c '"type":"text-delta"' > 1`.

---

## 2. Universal DoD checklist (per story)
- [ ] `bun run typecheck:all` no NEW failures over frozen baseline; `bun run test` green.
- [ ] ≥1 happy + ≥1 failure-path test per new public surface.
- [ ] Proof JSON (`.handoff/proof-stream-s1-NN.json`) → manager PROCEED.
- [ ] Demo artifact under `sprints/sprint-1/artifacts/`.
- [ ] No `--no-verify`, `@ts-ignore`, `as any`, silent catch, **no compat shim for the old event shape** (REQ-11).
- [ ] Brief-scope only — **no files outside the listed/checklist paths, incl. no notes files at repo root** (Sprint 0 m2).

---

## 3. Test plan

| Story | Layer | Test type | Key assertion |
|-------|-------|-----------|---------------|
| S1-01 | repo-wide | typecheck + full suite | no new typecheck:all failures; all migrated tests green; grep-clean for old `.text` |
| S1-02 | unit | `speakGated.modes` | **blocked sentence text absent from stream** (hard invariant); one start/end pair |
| S1-03 | integration | TextDriver | >1 delta before turn-end (ungated); buffered+no-leak (grounded); zero events (extraction) |

**Will NOT test this sprint:** native-realtime incremental streaming (Sprint 2); cascaded TTFT (Sprint 3) — S1-01 leaves both buffered.

---

## 4. Demo plan

**Demo:** an offline text example showing `text-start` → multiple `text-delta{id,delta}` → `text-end` for an ungated node and a single buffered message for a grounded node; `grep -c '"type":"text-delta"'` > 1 on the ungated transcript. Captured under `sprints/sprint-1/artifacts/`.

---

## 5. Risks specific to this sprint

| Risk | Detection | Mitigation |
|------|-----------|------------|
| **Hard invariant breach:** sentence mode emits a blocked sentence | `speakGated.modes` block test asserts the text is ABSENT | gate sentence BEFORE the `text-delta` emit; RFC §11 abort — stop, do not ship |
| Breaking union leaves a consumer red (huge blast radius) | `typecheck:all` no-new-failures gate + full `test` | the `.understanding/` 86-file checklist; full suite is the completeness backstop |
| Out-of-order / duplicate `text-start`/`text-end` | REQ-7 assertion in `speakGated.modes` | single `started` latch |
| Atomic-flip partial completion (IC context exhaustion) | sentinel absent / proof fails / typecheck red | re-delegate to continue; the gate can't pass on a partial flip |
| `AgentStreamPart` flip ripples to example hooks | typecheck | examples E14/E18 in the migration checklist |

---

## 6. Open questions

- O1–O4 resolved in §0 above. **`/delegate-review` is recommended on this sprint** (breaking-flip blast radius) — run it in Phase B before closeout.
- B-07 (possible dead `Hook.onStreamPart` surface) deferred to backlog, not removed this sprint.
