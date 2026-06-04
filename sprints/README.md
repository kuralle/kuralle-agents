# Sprints

Operating system for the Streaming-by-default build (`docs/rfc-streaming-by-default.md`).

| File / Folder | Role |
|---------------|------|
| [`WBS.md`](./WBS.md) | Work breakdown — 5 sprints, stories, universal DoD. **The plan.** |
| [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) | Paste once — long-running program session. **The driver.** |
| [`STATE.md`](./STATE.md) | Where we are now + build branch (`plan/streaming-by-default`). **The pointer.** |
| [`templates/`](./templates/) | PLAN, STORY-BRIEF, PROCEED-EVIDENCE, REVIEW-r1, WARMDOWN, HANDOFF. **The shape.** |
| `sprint-{N}/` | Per-sprint history (created as each sprint runs). |

---

## How a sprint runs

Build branch: `plan/streaming-by-default` (see [`STATE.md`](./STATE.md) § Build branch). No commits to `main` mid-sprint; merge to `main` is a single human PR after Sprint 4.

### Phase A — implementation

1. Paste [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md).
2. Read STATE → WBS → prior HANDOFF → the RFC sections STATE names → project memory.
3. Write `sprint-{N}/PLAN.md`.
4. Per story:
   - Run **`/code-understand`** when the story touches unfamiliar code (channel drivers, the gate, the realtime client, the cascaded adapter); link `.understanding/<slug>.md` in the brief.
   - Write `brief-{story}.md` → `/delegate --mode impl` (cursor) → proof JSON → atomic commit `[S{N}-{nn}]`.
   - Manager: `verify-handoff-proof.sh` → `proceed-S{N}-{nn}.md` (**PROCEED** / **HOLD**). The gate is `bun run typecheck:all` + the story's tests; for Sprints 1–2 the **hard invariant** is "sentence mode never emits a blocked sentence" — assert its absence.

No review workers between stories.

### Phase B — after all stories **PROCEED**

1. **Manager review** → `review-sprint.md` (sandwich; `REVIEW-r1.md` shape).
2. **Fix pass** → `[S{N}-fix]`.
3. **`/delegate-review`** on Sprint 1 (breaking flip) and Sprint 3 (TTFT); optional elsewhere.

### Close

WARMDOWN + HANDOFF + STATE → `[S{N}-close]`. Default: continue to N+1 in the same session. After Sprint 4: program-complete → human PR + real release (no autonomous publish).

---

## The roadmap (RFC chunks → sprints)

| Sprint | Phase | RFC chunks |
|--------|-------|-----------|
| 0 | Primitives | C2 (`streamGranularity`), C3 (`resolveStreamMode`), C4 (`SentenceAggregator`) |
| 1 | Protocol flip + text | C1 (lifecycle events, breaking), C5 (`speakGated`), C6 (`TextDriver`) + compile-critical consumer/test updates |
| 2 | Voice (native realtime) | C7 (`VoiceDriver` shared path + honest post-hoc gate, REQ-9) |
| 3 | Cascaded TTFT | C8 (adapter `text-delta.delta` + first-chunk-before-turn-end) |
| 4 | Polish + 0.4.0 | C10 (smoke + docs + ADR 0004), C11 (unified `0.4.0`) |

---

## Roles

| Role | Phase | Job |
|------|-------|-----|
| **Manager** | A + B + close | Plan, brief, proceed evidence, review, fix, warm-down. Owns final diff. |
| **IC (cursor)** | A (+ fix briefs) | One story, proof JSON, atomic commit. Fresh process per story. |
| **Explorer (`/code-understand`)** | Before brief | Map existing code when blast radius is unclear. Read-only. |

Ad-hoc without sprint OS → **`/managed-session`**. Adversarial second opinion → **`/delegate-review`** (default on Sprints 1 and 3).

---

## Commits

| Commit | Owner |
|--------|-------|
| `[S{N}-{nn}]` per story | cursor (IC) |
| `[S{N}-fix]` | manager |
| `[S{N}-close]` | manager |

---

## What lives where

| You want to know... | Read... |
|---------------------|---------|
| What's the plan? | [`WBS.md`](./WBS.md) |
| What sprint are we in? | [`STATE.md`](./STATE.md) |
| How does a session run? | [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) |
| Why these modes / events? | `docs/rfc-streaming-by-default.md` |
| What did sprint N do? | `sprint-{N}/WARMDOWN.md` |
| What does sprint N+1 need? | `sprint-{N}/HANDOFF.md` |
| Why was decision X made? | `review-sprint.md` + `proceed-*.md` |
| Code map before build | `.understanding/<slug>.md` |
