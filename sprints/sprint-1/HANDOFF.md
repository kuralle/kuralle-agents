# Handoff — Sprint 1 → Sprint 2

> **One page. Read first.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

## State of the world (one paragraph)
Sprint 1 (Protocol flip + text path) is complete: the breaking `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle is live across all three unions and every in-repo consumer, and `TextDriver` now streams via the shared `speakGated` (ungated reply → >1 delta before turn-end; grounded → buffered). Full `test` suite green; `typecheck:all` shows zero new failures over the 4 frozen baseline configs (B-06). Sprint 2 routes **`VoiceDriver`** (native realtime) through the same `speakGated` path — the new twist is REQ-9: the provider speaks audio before any Kuralle gate runs, so the whole-answer gate is **post-hoc/advisory**, never "blocked-before-emission".

## Sprint 2 goal (verbatim from WBS)
**Route `VoiceDriver` through `speakGated` via a transcript-backed `TokenSource` so the native realtime assistant transcript streams incrementally, with the whole-answer gate running honestly post-hoc (REQ-9) and barge-in/truncate preserved.**
Full section: `sprints/WBS.md` § Sprint 2 (S2-01 transcript `TokenSource`; S2-02 honest post-hoc gate).

## Read these first (in order, before delegating)
1. `sprints/STATE.md` — active sprint = 2 + load-bearing reading.
2. `sprints/WBS.md` § Sprint 2.
3. `sprints/sprint-1/WARMDOWN.md` §10 (pointers) + §4 (KI-1-04).
4. `docs/rfc-streaming-by-default.md` — §2.4 (two voice substrates), §5.1 (VoiceDriver change), §10 (security), REQ-8, **REQ-9 (native realtime honesty — the defining constraint)**.
5. `packages/kuralle-core/src/runtime/channels/VoiceDriver.ts` — the accumulate-then-emit block (now emitting the one-shot trio) to replace; preserve `heardCharCount`/`truncateAt`/barge-in (`onInterrupted`).
6. `packages/kuralle-core/src/runtime/channels/streaming/speakGated.ts` — the shared path; build a transcript-backed `TokenSource` over `onTranscript`.
7. **Before S2-01:** `/code-understand` the realtime client (`RealtimeAudioClient.ts` / `@kuralle-agents/realtime-audio`) `onTranscript`/`heardCharCount`/barge-in path; link the artifact in the brief.

## Traps to know about
- **REQ-9 honesty (the sprint's defining constraint):** native realtime provider speaks audio as it generates; a whole-answer content gate cannot un-speak it. Tests + voice README must say the gate is **advisory** (truncate + correction), never "blocked before emission". Input-side gating + tool authority are the reliable controls there.
- **Hard invariant nuance:** unlike text/cascaded, the "never emit blocked content" invariant CANNOT hold for native realtime audio — do not assert it does. (It still holds for the cascaded substrate.)
- Preserve existing barge-in / `truncateToHeard` behavior — only the emission path changes; the existing voice interrupt tests must stay green.
- `typecheck:all` RED baseline (4 configs, B-06) — use the frozen-baseline guard (`sprints/sprint-1/artifacts/guard-stream-s1-01.sh`), not "exit 0".
- Migration grep must cover `*.ts` AND `*.js`/`*.mjs` (Sprint-1 grep-clean blind spot).
- Cursor proof-JSON hygiene is unreliable — independently re-verify every claim; repair proofs as needed.

## Open issues that block sprint 2
No blockers. (B-06 = Sprint-4 release blocker; B-07 = post-0.4.0 investigation.)

## Start by running
```bash
cd /Users/mithushancj/Documents/asyncdot/openscoped/aria-flow && git checkout plan/streaming-by-default && cat sprints/STATE.md && bun run build && bun run test
```

## When you're done
Continue the program per `SESSION_KICKOFF_PROMPT.md`: Sprint 2 (Step 0 boundary → 1 → 2 → 3), then Sprint 3 (cascaded TTFT — `/delegate-review` recommended), then Sprint 4 (polish + 0.4.0 dry-run; program-complete → human release handoff).
