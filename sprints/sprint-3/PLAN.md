# Sprint 3 — Plan

**Sprint name:** Cascaded TTFT
**Sprint goal (one sentence):** Make `KuralleRuntimeLLMStream.run` consume `text-delta.delta` and handle the lifecycle so the LiveKit cascaded path begins TTS before the runtime turn completes and `aria_runtime_ttft` drops to first-token latency.
**Sprint window:** 2026-06-05 (continued session)
**Author (main session):** Opus 4.8 (1M) · 2026-06-05

---

## 0. Pre-landed code + framing (manager notes)

- **S3-01's adapter code already landed in `[S1-fix]` (`0a65cad`).** `KuralleRuntimeLLMAdapter.ts` already: consumes `part.delta` (`:231`), ignores `text-start`/`text-end` (`:214-216`), handles `text-cancel` (skips canceled turns, `:209-212,222-224`), and **fires `recordTtftOnce()` on the FIRST `text-delta`** (`:226`, latched `:177-185`) — exactly REQ-10. So Sprint 3 is **proof-dominant**, not new-code-dominant.
- **§11 abort framing (critical):** TTFT improves only for a **token/sentence-mode (ungated)** reply — `speakGated` streams the first delta early. A **`turn`-mode gated node still buffers** (REQ-3), so its first chunk legitimately lands at turn-end — that is **correct, NOT an abort**. The §11 abort fires only if a *streaming (ungated)* reply's first chunk still arrives at turn-end (⇒ something upstream still buffers → STOP + re-diagnose, do not paper over).
- The live `ws-cascaded-e2e.ts` requires LiveKit Cloud + OpenAI keys and **skips** without them, so it cannot be the deterministic gate. The deterministic §11 gate is an **offline adapter unit test** (S3-01).

---

## 1. Stories

### `S3-01` — Adapter TTFT-on-first-delta proof (deterministic, offline) — the §11 gate
**Description:** Add a deterministic unit test that drives `KuralleRuntimeLLMAdapter.run` (or `KuralleRuntimeLLMStream`) with a **fake runtime** whose `handle.events` yields multiple `text-delta`s (with the first well before turn-end), and a captured metrics sink. Prove `aria_runtime_ttft` is recorded **at the first `text-delta`**, ordered **before** later deltas reach the queue and **before** `aria_runtime_end`/`done`. Confirm the existing cancel-halt behavior. (Adapter code is already correct — this story proves it and is the §11 gate.)

**Acceptance criteria:**
1. Fake runtime yields `text-start` → `delta1` → `delta2` → `delta3` → `text-end` → (turn-end/done). Captured metrics: `aria_runtime_ttft` emitted exactly once, and its emission is ordered **before** the 2nd queue chunk and before `aria_runtime_end`. (Proves TTFT = first-token, not whole-turn.)
2. A control case (single trailing delta = buffered/turn-mode shape) records TTFT at that single delta — i.e., the adapter never waits for `done` to record TTFT.
3. `text-cancel` mid-turn halts forwarding for that turn id (already covered by `aria_runtime_llm_adapter.test.ts:194-198` — keep green).
4. `bun run build` exit 0; `bun run test` green; `typecheck:all` no-new-failures (guard).

**Files:** `packages/kuralle-livekit-plugin/test/aria_runtime_llm_adapter.test.ts` (extend); no adapter src change expected (if a change IS needed, that itself is a finding — note it).

### `S3-02` — TTFT e2e proof + before/after metric (live + offline artifact)
**Description:** Extend `ws-cascaded-e2e.ts` to assert, on a streaming (ungated) reply, the **first TTS audio chunk is produced before the runtime turn emits `turn-end`/`done`**, and record a before/after `aria_runtime_ttft` number. The e2e is skip-guarded (live keys); ALSO capture a **deterministic offline artifact** (from the S3-01 harness or a small offline driver) showing first-chunk-before-turn-end + the TTFT timing, so the proof exists without live keys.

**Acceptance criteria:**
1. The e2e (when live keys present) asserts first TTS chunk before `turn-end`/`done` for an **ungated** reply node; logs `aria_runtime_ttft`.
2. An offline artifact (`sprints/sprint-3/artifacts/s3-ttft.txt`) shows: ungated reply ⇒ TTFT ≈ first-token (recorded before turn-end); and documents that a gated (turn-mode) node buffers by design (no improvement expected).
3. **§11 check:** if the ungated-reply TTFT does NOT precede turn-end, **STOP** — re-diagnose `speakGated`/`TextDriver` buffering; do not paper over.
4. `typecheck:all` no-new-failures; `test` green.

**Files:** `ws-cascaded-e2e.ts` (extend); `sprints/sprint-3/artifacts/s3-ttft.txt`.

---

## 2. Universal DoD
Same as prior sprints: no-new-typecheck, full test green, behavioral tests, proof JSON → PROCEDE, no suppression, brief-scope only, grep `*.ts`+`*.js`+`*.mjs`.

## 3. Test plan
| Story | Layer | Type | Key assertion |
|-------|-------|------|---------------|
| S3-01 | unit (fake runtime) | TTFT timing/ordering | `aria_runtime_ttft` recorded at first delta, before 2nd chunk + before `aria_runtime_end` |
| S3-02 | e2e (live, skip-guarded) + offline artifact | first-chunk-before-turn-end | ungated reply: first TTS chunk before turn-end; gated buffers by design |

## 4. Demo plan
Offline artifact: a captured event/metric timeline showing `aria_runtime_ttft` at the first delta and the first queue chunk before turn-end for an ungated reply. Under `sprints/sprint-3/artifacts/`.

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| **§11: TTFT doesn't improve** for a streaming reply | S3-01 ordering assertion / S3-02 first-chunk-before-turn-end | if red → STOP + re-diagnose `speakGated`/`TextDriver` token flow; do not paper over (RFC §11) |
| Confusing "gated node buffers" with a TTFT regression | use an UNGATED node for the improvement proof; document gated=buffered-by-design | framing in §0 |
| Live e2e unrunnable (no keys) | skip-guard | deterministic offline artifact is the real gate (S3-01) |

## 6. Open questions
- `/delegate-review` **recommended** on this sprint (the latency claim) — run in Phase B; have it independently confirm the TTFT-on-first-delta ordering and that no upstream buffering remains for ungated replies.
