# Claim Verification Results — teardown + voice-framework gaps

**Date:** 2026-07-11 · **Status:** Ready for review
**Verifies:** [`docs/kuralle-core-teardown.md`](./kuralle-core-teardown.md) (F1–F9, H1–H3, C2) and
[`docs/agentic-voice-framework-gaps.md`](./agentic-voice-framework-gaps.md) (G1–G18).
**Method:** every load-bearing claim was re-checked with a **runnable, deterministic pass/fail loop** —
either a live-provider trace or a source-structure assertion — never by re-reading the doc.

## How each mode works

- **Live (behavioral).** A real Kuralle runtime (`createRuntime`) driven by a **real provider —
  `openai:gpt-4.1-mini`** — runs the documented trace. The assertion is on the deterministic
  *mechanism* the doc names (durable-journal executor call-counts, `session.messages` contents,
  persisted flow state, thrown limit errors), never on model prose. The live model only drives turns.
  Harness: [`packages/core/test/audit-validation/live/verify-live-claims.ts`](../packages/core/test/audit-validation/live/verify-live-claims.ts).
  Evidence: `runs/result-live-verification.json`.
- **Structural.** For claims whose own evidence in the doc is structural (dead code, config defaults,
  scoping), the exact cited source property is asserted (call-site counts, single write sites, default
  values) — the same method the doc used. A live model adds no signal to "this symbol has zero callers."
  Harness: [`packages/core/test/audit-validation/structural-verify.sh`](../packages/core/test/audit-validation/structural-verify.sh).
  Evidence: `runs/result-structural-verification.json`.
- **Baseline.** The pre-existing fake-model harness `packages/core/test/audit-validation` (F1–F9 +
  replay-false) still passes **22/22** — the claims reproduce at the unit level before any live work.

## Scorecard — 19 / 19 CONFIRMED, 0 refuted

| Gap / Finding | Claim | Mode | Verdict | Key observed evidence |
|---|---|---|---|---|
| **F6 / G8** | 2nd identical durable tool call in a session replays the 1st result without executing | live | ✅ CONFIRMED | turn-2 emitted a `get_balance` tool-call but `executorCalls` stayed at **1** → user gets a stale balance |
| **G18 / §5** | Free-conversation tool calls/results never enter `session.messages` | live | ✅ CONFIRMED | after a tool turn, `session.messages` roles = `[user, assistant]` only; **no** tool-call/tool-result part persisted |
| **F5 / §4.1** | Populated `instructions` ⇒ answering agent; flows are LLM-gated (determinism is opt-in) | live | ✅ CONFIRMED | `deriveAgentShape.isAnsweringAgent=true`; an off-flow question was answered without entering the SOP flow |
| **F7** | `maxTurns` is session-cumulative and never reset — once exceeded the thread is permanently bricked | live | ✅ CONFIRMED | with `maxTurns:2`, turns 3 **and** 4 both threw `maxTurns exceeded (2)` |
| **F9** | A flow completed once is one-shot — `__completedFlows` never cleared | live | ✅ CONFIRMED | `__completedFlows=["order-cake"]` after the 1st order; the 2nd same-flow request could not re-enter |
| **G17 / §6** | A mid-flow handoff leaves `run.activeFlow` set → the target throws `Active flow not found` | live | ✅ CONFIRMED | collect-suspend repro threw **`Active flow "intake" not found on agent "billing"`**; `activeFlow` still `"intake"` after handoff |
| **G6** | `retrievalCache` / `createSessionCache` are dead; owner `IntakeStage` does not exist | structural | ✅ CONFIRMED | `createSessionCache` call-sites=0 (definition only); `ctx.retrievalCache` reads=0; `class IntakeStage`=0 (comment only) |
| **G12** | `handoffFilters.inputFilter` is never invoked (dead API) | structural | ✅ CONFIRMED | `inputFilter(` call-sites = **0**; raw messages transfer on handoff |
| **G2** | `experimental.outOfBandControl` defaults to `false` | structural | ✅ CONFIRMED | `?? false` default at `Runtime.ts:226` + `ctx.ts:181` |
| **C2** | `SessionMutex` is an in-memory per-process map; cross-process concurrency unguarded | structural | ✅ CONFIRMED | `class SessionMutex` present; stores are last-write-wins blob writes (no version column) |
| **F1** | The real-usage `TokenAccumulator` is never constructed; budgeting is chars/4 | structural | ✅ CONFIRMED | `new TokenAccumulator` sites = **0** |
| **G9** | No parallel tool execution — `parallelExecution` defaults false; dispatch is a serial loop | structural | ✅ CONFIRMED | serial `for (const call of toolCalls)` in `TextDriver`; `parallelExecution` gated off |
| **G1** | `__flowPark` is a single overwritten slot, not a stack | structural | ✅ CONFIRMED | no `__flowParkStack`/`FlowPark[]`; `setFlowPark` writes one object |
| **G14** | No `resetCollect` — a collected slot is write-once (confirm-decline re-fires stale value) | structural | ✅ CONFIRMED | `resetCollect` refs = **0** |
| **G16** | Handoff does not rebuild persona/executor (chimera agent) | structural | ✅ CONFIRMED | `baseInstructions` has a **single** write site; `CoreToolExecutor` tool map built once (`private readonly`) |
| **G5** | No structured goal/intent/topic/thread field on `Session`/`RunContext` | structural | ✅ CONFIRMED | typed goal/intent/topic/thread fields = **0** (only a test persona) |
| **G4** | `handoffCount` re-zeroed each turn; `handoffHistory` never read for loop suppression | structural | ✅ CONFIRMED | `handoffCount` reset site present; `handoffHistory` written but not read for suppression |
| **H1** | Effects execute **before** the durable step is appended (at-least-once, not exactly-once) | structural | ✅ CONFIRMED | `ctx.ts` order is `execute()` then `appendStep` |
| **H3** | The durable step journal is never pruned (O(history) blob growth) | structural | ✅ CONFIRMED | no step-prune/clear site exists |

## Notable diagnosis note (G17 — why it took three repros)

G17 first appeared **REFUTED** twice. Both were *false refutations*, not real ones: a `reply` node
returning `'stay'` and an `action` node that hands off on the fresh-entry turn both leave
`activeFlow=undefined` — they never take the suspend-and-persist path. The documented crash is only
reachable via `runActiveFlow` (`hostLoop.ts:138` returns `kind:'handoff'` **without** clearing
`activeFlow`), which runs only when the flow was **already active from a prior turn**. Only a
`collect` node genuinely suspends and persists `activeFlow` across turns. The faithful repro
(collect suspends on turn 1 → completes → action handoff on turn 2) reproduced the exact error.
**Lesson:** do not accept a refutation until the repro faithfully exercises the documented mechanism.

## G18 nuance

The model frequently *speaks* a retrieved value, so it lands in history via the assistant text. The
load-bearing claim — and what the check asserts — is that the **structured** tool-call/tool-result
parts are not persisted, so any data the model retrieves-but-does-not-verbalize is unreferenceable on
the next turn. That mechanism is confirmed.

## Reproduce

```bash
# baseline (fake-model, unit): 22 pass
cd packages/core && bun test test/audit-validation

# live behavioral (needs OPENAI_API_KEY in .env): 6/6 CONFIRMED
KURALLE_EXAMPLE_PROVIDER=openai OPENAI_MODEL=gpt-4.1-mini \
  bun test/audit-validation/live/verify-live-claims.ts

# structural: 13/13 CONFIRMED
bash test/audit-validation/structural-verify.sh
```

Canonical merged evidence: `runs/result-claim-verification.json`.

---

## Fixes landed (2026-07-11, Factory drive — worker: grok, boss-verified)

**12 of 17 board tasks verified-done** (gate: `bun test test/audit-validation` + `bun run typecheck:all`, boss-re-run; several also live-behaviour-verified). **Live snapshot: 5 of 6 findings no longer reproduce** (G8, G18, F7, F9, G17 → REFUTED). The 1 remaining live-CONFIRMED (LIVE-C) is an answering agent free-conversing an off-flow aside — correct hybrid behaviour that is kept; the G2 `outOfBandControl` default-flip is verified by `f5g2-determinism-default.test.ts` + a live no-regression pass.

| Task | Lane | Verified by |
|---|---|---|
| Keystone — journal scoping (F6/G8, H3) | full | gate + live LIVE-A flipped to fixed |
| G17 mid-flow handoff | approve | gate + live LIVE-F fixed |
| G1 park stack | approve | gate + live digression parks/resumes |
| G4 handoff oscillation | approve | gate + unit |
| G16 rebuild agent surface | approve | gate + live (Bob persona + tool, no Unknown tool) |
| F7 maxTurns reset | approve | gate + live 4/4 turns answered |
| G12 wire inputFilter | approve | gate + unit |
| F9 reset __completedFlows | approve | gate + live LIVE-E fixed |
| G18 tool-results-to-history | approve | gate + live LIVE-B fixed |
| F1 real token usage | approve | gate + unit |
| G5 goal/thread tracking | approve | gate + unit (additive, opt-in) |
| F5/G2 determinism default | **full** | gate + live no-regression (hybrid intact) |

**Staged (todo, blueprints on the board + docs/peer-solutions-matrix.md):** C2 (store CAS — full-lane), H1 (intent-before-execute — needs a crash harness), G14 (slot correction — needs a mini-spike), G6 (retrieval cache — needs consumer design), G9 (parallel tools — needs concurrency-safe journal). Each has a staging comment explaining the blueprint and why it awaits human design/review.

**Live test assets built:** `packages/core/test/audit-validation/live/chat-cli.ts` (reusable scriptable chat driver), `verify-fixes.ts` (behavioural fix proofs), `verify-live-claims.ts` (board-wide bug-reproduction snapshot). Per-task metrics in `runs/metrics.jsonl`.
