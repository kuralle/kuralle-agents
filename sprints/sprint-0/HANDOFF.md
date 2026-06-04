# Handoff — Sprint 0 → Sprint 1

> **One page. Read this before doing anything else.** Depth lives in [`WARMDOWN.md`](./WARMDOWN.md); this is the read-me-first.

---

## State of the world (one paragraph)

Sprint 0 (Primitives) is complete: the three additive building blocks — `streamGranularity?` on the gate interfaces, `SentenceAggregator`, and the pure `resolveStreamMode` — are shipped, unit-tested, and consumed by nothing yet, so repo behavior is unchanged (`build` + `test` green). Sprint 1 is the **breaking protocol flip**: it removes the single-shot `{type:'text-delta',text}` and replaces it with the `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle on both unions, then routes `TextDriver` through a new shared `speakGated` so an ungated reply streams >1 delta while a grounded node still buffers. **Up front:** `typecheck:all` is RED at baseline (pre-existing test/example drift, 4 configs) — do not treat its non-zero exit as your regression; use the frozen-baseline guard (`sprints/sprint-0/artifacts/guard-stream-s0-01.sh`) to prove "no NEW failures."

---

## Sprint 1 goal (verbatim from WBS)

**Replace the single-shot `text-delta` with the `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle across both unions and route `TextDriver` through `speakGated`, so an ungated text reply emits more than one delta before turn-end while a grounded node still buffers — `typecheck:all` and `test` green at close.**

Full section: `sprints/WBS.md` § Sprint 1 (stories S1-01 breaking flip, S1-02 `speakGated`+`TokenSource`, S1-03 `TextDriver` on shared path).

---

## Read these first (in this order, before delegating any story)

1. `sprints/STATE.md` — confirms active sprint = 1 + the load-bearing reading list.
2. `sprints/WBS.md` § Sprint 1.
3. `sprints/sprint-0/WARMDOWN.md` §10 (pointers) + §4 (known issues KI-0-02 heuristic).
4. `docs/rfc-streaming-by-default.md` §4.1–4.2 (lifecycle, REQ-6/7), §4.5 (`speakGated`+`TokenSource`), §5.1 (TextDriver), §6 (pseudocode), §7 (blueprint), §11 (abort criteria).
5. **Before S1-01:** run `/code-understand` on the `HarnessStreamPart` (`types/stream.ts`) + voice-union (`types/voice.ts`) **consumers** — the breaking flip's blast radius is the whole sprint risk. Link the artifact in the S1-01 brief.
6. Sprint-0 primitives to wire: `runtime/channels/streaming/{mode.ts,SentenceAggregator.ts}`; the post-turn gate `runtime/policies/agentTurn.ts:236-272` (becomes `speakGated`'s `runGate`).

---

## Traps to know about

- **`typecheck:all` is RED at baseline.** Use the frozen-baseline guard (diff the FAIL-config set vs the 4 known configs), never "exit 0". Baseline = `kuralle-core/test`(5), `kuralle-engagement/examples/{booking,clothing,pharmacy}`(4/3/2). Tracked B-06.
- **Hard invariant (Sprints 1–2):** sentence mode must NEVER emit a blocked sentence's text. Assert its **absence** from the captured stream, not just that a safe message appears (RFC §11 abort if breached — stop, do not ship).
- **REQ-7:** exactly one `text-start`/`text-end` pair per turn; single `started` latch in `speakGated`.
- **Stale dist:** rebuild `kuralle-core` after editing its `src` before any downstream package consumes the new event shape.
- **`SentenceAggregator` heuristic (KI-0-02):** short final sentence emerges via `flush()`, not `push()` — fine for `speakGated` (it gates the flush tail), but decide keep-or-remove when wiring S1-02/03.
- **Brief discipline (from Sprint 0):** explicitly forbid any file outside the listed paths (ICs littered repo root), and quote the exact proof `claims[]` schema (`id`+`type`+`cwd`, not `claim_id`).

---

## Open issues that block sprint 1

No open blockers. (B-06 is a Sprint-4 release blocker, not a Sprint-1 blocker.)

---

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot/openscoped/aria-flow && git checkout plan/streaming-by-default && cat sprints/STATE.md && bun run build && bun run test
```

---

## When you're done

Continue the program: open Sprint 1 per `SESSION_KICKOFF_PROMPT.md` (Step 0 sprint boundary → Step 1). `/delegate-review` is **recommended** on Sprint 1 (breaking flip blast radius).
