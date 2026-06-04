# Handoff — Sprint 2 → Sprint 3

> **One page. Read first.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

## State of the world (one paragraph)
Sprint 2 (Voice — native realtime) is complete: `VoiceDriver` streams the assistant transcript via the shared `speakGated` (push-to-pull `deferredTokenSource`), barge-in/`truncateToHeard` preserved, and the whole-answer gate runs **honestly post-hoc** (REQ-9 — emits `safety-blocked` + a provider correction, records `gateScope:'advisory'`, never claims native audio was blocked-before-emission; documented in the voice README). Full `test` green; `typecheck:all` no new failures over the 4 frozen baseline configs (B-06). Sprint 3 makes the **LiveKit cascaded adapter** stream for TTFT: consume `text-delta.delta`, fire `recordTtftOnce` on the FIRST delta, and prove the first TTS chunk precedes `turn-end`/`done` — with a hard **§11 abort if TTFT doesn't improve**.

## Sprint 3 goal (verbatim from WBS)
**Make `KuralleRuntimeLLMStream.run` consume `text-delta.delta` and handle the lifecycle so the LiveKit cascaded path begins TTS before the runtime turn completes and `aria_runtime_ttft` drops to first-token latency.**
Full section: `sprints/WBS.md` § Sprint 3 (S3-01 adapter lifecycle/TTFT; S3-02 TTFT proof e2e).

## Read these first (in order)
1. `sprints/STATE.md` — active sprint = 3 + load-bearing reading.
2. `sprints/WBS.md` § Sprint 3.
3. `sprints/sprint-2/WARMDOWN.md` §10.
4. `docs/rfc-streaming-by-default.md` — §7 (cascaded blueprint), REQ-10, §1 success criterion #2, **§11 abort criteria**.
5. `packages/kuralle-livekit-plugin/src/llm/KuralleRuntimeLLMAdapter.ts` — run loop (already `.delta` + `text-cancel` handling from S1-fix `0a65cad`); `recordTtftOnce` (`:176`); the queue push.
6. `packages/kuralle-livekit-plugin-transport-ws/test/e2e/ws-cascaded-e2e.ts` — the cascaded e2e to extend for the first-chunk-before-turn-end assertion + before/after `aria_runtime_ttft`.

## Traps to know about
- **§11 ABORT (hard):** if cascaded TTFT does NOT improve (first chunk still at turn-end), STOP and re-diagnose — do NOT paper over. The likely cause would be upstream buffering in `speakGated`/`TextDriver` token flow; re-diagnose there. **Surface the abort, do not work around it.**
- The adapter already consumes `.delta` and handles `text-cancel` (S1-fix). Sprint 3's NEW work: `recordTtftOnce` must fire on the FIRST `text-delta` (not at `done`), and the e2e must assert first-TTS-chunk-before-`turn-end`.
- `typecheck:all` RED baseline (4 configs, B-06) — use the frozen-baseline guard, not "exit 0". Grep across `*.ts`+`*.js`+`*.mjs`.
- `/delegate-review` is **recommended** on Sprint 3 (the latency claim warrants an adversarial second opinion + an independent metric check).

## Open issues that block sprint 3
No blockers. (B-06 = Sprint-4 release blocker; B-07/B-08 = post-0.4.0 / live-validation.)

## Start by running
```bash
cd /Users/mithushancj/Documents/asyncdot/openscoped/aria-flow && git checkout plan/streaming-by-default && cat sprints/STATE.md && bun run build && bun run test
```

## When you're done
Continue per `SESSION_KICKOFF_PROMPT.md`: Sprint 3 (`/delegate-review` recommended; §11 abort live) → Sprint 4 (docs + ADR-0004 + unified `0.4.0` `pnpm publish -r --dry-run`; **no real publish/merge** — program-complete → hand off to a human PR + real release + live smoke).
