# Sprints

Operating system for the Kuralle Engagement build.

| File / Folder | Role |
|---------------|------|
| [`WBS.md`](./WBS.md) | Work breakdown — stories, universal DoD. **The plan.** |
| [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) | Paste once — long-running program session, sprint after sprint. **The driver.** |
| [`STATE.md`](./STATE.md) | Where we are now + build branch. **The pointer.** |
| [`templates/`](./templates/) | PLAN, STORY-BRIEF, PROCEED-EVIDENCE, REVIEW-r1, WARMDOWN, HANDOFF. **The shape.** |
| `sprint-{N}/` | Per-sprint history. |

---

## How a sprint runs

Build branch: **`plan/whatsapp-engagement`** (see [`STATE.md`](./STATE.md)). No commits to `main` mid-sprint.

### Phase A — implementation

1. Paste [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md).
2. Read STATE → WBS → prior HANDOFF.
3. Write `sprint-{N}/PLAN.md`.
4. Per story:
   - Run **`/code-understand`** when the story touches unfamiliar code; link `.understanding/<slug>.md` in the brief.
   - Write `brief-{story}.md` → `/delegate --mode impl` (cursor) → proof JSON → atomic commit `[S{N}-{nn}]`.
   - Manager: `verify-handoff-proof.sh` → `proceed-S{N}-{nn}.md` (**PROCEED** / **HOLD**).

No review workers between stories — proceed evidence only.

### Phase B — after all stories **PROCEED**

1. **Manager review** → `review-sprint.md` (sandwich).
2. **Fix pass** → `[S{N}-fix]`.
3. Optional: `/delegate-review` if adversarial second opinion is needed (not default).

### Close

WARMDOWN + HANDOFF + STATE update → `[S{N}-close]`. **Default:** continue to sprint N+1 in the same session (Step 4). Stop only when WBS complete, user pause, or hard flag.

---

## Roles

| Role | Phase | Job |
|------|-------|-----|
| **Manager** | A + B + close | Plan, brief, proceed evidence, review, fix, warm-down. Owns final diff. |
| **IC (cursor)** | A (+ fix briefs) | Implement one story, proof JSON, atomic commit. Fresh process per story. |
| **Explorer (via `/code-understand`)** | Before brief | Map existing code when blast radius is unclear. Read-only. |

Ad-hoc work without sprint OS → **`/managed-session`**.

---

## Commits

| Commit | Owner |
|--------|-------|
| `[S{N}-{nn}]` per story | cursor (IC) |
| `[S{N}-fix]` | manager |
| `[S{N}-close]` | manager |

Ad-hoc without sprint OS → **`/managed-session`**. Adversarial review → **`/delegate-review`**.
