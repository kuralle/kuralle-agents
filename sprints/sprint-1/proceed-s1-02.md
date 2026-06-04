# Proceed Evidence — `S1-02` speakGated + TokenSource

> Manager artifact — Phase A. Carries the RFC §11 hard invariant.

## Story
- **Id:** `S1-02`
- **Commit:** `245f2cc` — `[S1-02] speakGated + TokenSource` (4 files, +403)
- **IC slug:** `stream-s1-02` (worker: cursor)

## Proceed checklist (manager — read impl + invariant test directly)
- [x] `verify-handoff-proof.sh stream-s1-02` → `PROOF_OK` (2 claims, 5 assertions) — proof well-formed this time.
- [x] **`speakGated.ts` gates BEFORE emit (structural invariant):** in `sentence` mode a sentence reaches `ctx.emit` only via `emitCleared` (`:87-91`), called only after `runGate` returns not-blocked (`:97-102`); a blocked sentence returns via `emitBlockedSafeMessage` (`:25-45`) and is NEVER emitted as a delta. `turn` mode accumulates→gates once→emits.
- [x] **Hard invariant test asserts ABSENCE** (`speakGated.modes.test.ts:160-162`): first sentence emitted; `deltas).not.toContain(blockedSentence)` AND `deltas.some(d => d.includes(blockedSentence))).toBe(false)` — blocked text absent as exact-match AND substring. Plus turn-mode "Secret" absence (`:131`).
- [x] REQ-7: single `started` latch (`:77,80-85`); one start/end pair per turn. `text-cancel{id,reason}` precedes a fresh-id safe lifecycle on block (`:166`).
- [x] Error path: source throw ⇒ `{type:'error'}` + `text-cancel` if started (`:132-138`, test `:189+`).
- [x] `bun test speakGated.modes` → 7 pass / 0 fail / 31 expect. Manager re-ran: green.
- [x] No suppression (0 hits); scope clean (4 files, no stray root files); `typecheck:all` no-new-failures (guard).

**Verdict:** `PROCEED`

## One-line summary
Shared gated emitter `speakGated` (token/sentence/turn) + `TokenSource`; blocked sentence proven absent from the stream (RFC §11), one start/end per turn · commit `245f2cc`.

## Notes
- The blocked-sentence-absent assertion (exact + substring) is exactly the RFC §11 abort guard — verified directly, not by test name. Structurally the gate runs before emit, so the invariant holds by construction.
- Proof was well-formed this run (unlike S0-03/S1-01) — the explicit claim-schema instruction in the brief helped.
- `speakGated` is pure of driver coupling — S1-03 wires it into `TextDriver`.
