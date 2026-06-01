# Sprints

This directory is the operating system of the Kuralle Engagement build. Four things live here:

| File / Folder | Role |
|---------------|------|
| [`WBS.md`](./WBS.md) | Work breakdown structure. The full sprint plan, story-by-story, with the universal Definition of Done and engineering practice. **The plan.** |
| [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) | The prompt a fresh Claude Code session pastes in to advance the project by one sprint. **The driver.** |
| [`STATE.md`](./STATE.md) | The single source of truth for "where are we right now." **The pointer.** |
| [`templates/`](./templates/) | The artifact templates every sprint uses (PLAN, STORY-BRIEF, STORY-BRIEF-GATE, STORY-BRIEF-R2, REVIEW-r1, REVIEW-r2, SYNTHESIS, WARMDOWN, HANDOFF). **The shape.** |
| `sprint-{N}/` | One folder per sprint, populated as we go. **The history.** |

---

## How a sprint runs

A sprint executes in **two phases**.

### Phase A — implementation, atomic commits per story

1. A fresh Claude Code session opens at the project root.
2. The user pastes the contents of [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md).
3. The session reads [`STATE.md`](./STATE.md) → finds the active sprint → reads its WBS section.
4. The session writes `sprint-{N}/PLAN.md` from the [PLAN template](./templates/PLAN.md).
5. For each story in order:
   - Manager writes `sprint-{N}/brief-{story}.md` from the [STORY-BRIEF template](./templates/STORY-BRIEF.md), including a commit-policy section.
   - Manager fires **a fresh `cursor` process** for that one story (clean context window). Cursor implements the brief, runs build/test, **commits atomically** with `[S{N}-{nn}] {short title}`, and exits.
   - Manager moves to the next story brief; fires a fresh cursor; repeat.

**No per-story reviews during Phase A.** All review happens at sprint level in Phase B.

### Phase B — sprint-level review, after every story is committed

6. **Spec + code-quality gate (`pi`):** manager writes `sprint-{N}/brief-sprint-gate.md` from the [GATE template](./templates/STORY-BRIEF-GATE.md). Pi reads every story brief + every commit and writes `sprint-{N}/gate-sprint.md` with verdict `green / yellow / red`. Pi is the team-level gate — peer-IC, NOT adversarial.
7. **Manager r1 critical review:** read pi's gate + the full sprint diff. Write `sprint-{N}/review-sprint-r1.md` from the [r1 template](./templates/REVIEW-r1.md) using the sandwich method.
8. **Codex r2 adversarial review (`codex`):** when the sprint includes source/test code, manager writes `sprint-{N}/brief-sprint-r2.md` from the [r2 brief template](./templates/STORY-BRIEF-R2.md) and fires codex. Codex reads gate + r1 + diff and writes `sprint-{N}/review-sprint-r2.md` from the [r2 template](./templates/REVIEW-r2.md). r2 is the strongest spec + quality + adversarial gate. **Skip rule:** if the sprint has zero source/test changes (config-only / docs-only), r2 is skipped.
9. **Manager fix pass:** apply every `Apply now` item from gate + r1 + r2. Direct edits, or a focused fix brief to cursor. Commit atomically with `[S{N}-fix] {description}`.
10. **Manager warm-down:** write `sprint-{N}/WARMDOWN.md` from the [WARMDOWN template](./templates/WARMDOWN.md), `sprint-{N}/HANDOFF.md` from the [HANDOFF template](./templates/HANDOFF.md), update [`STATE.md`](./STATE.md), and commit `[S{N}-close] WARMDOWN + HANDOFF + STATE pointing to sprint N+1`.
11. Session ends.
12. Next session repeats from step 1 with sprint N+1.

The session never runs more than one sprint. The sprint is the unit of accounting. **Time, fatigue, and complexity are not excuses to compress the loop.**

---

## The roles

The four-role hierarchy:

- **Main session (manager)** = engineering manager. Plans the sprint, writes briefs, fires workers, reviews adversarially (r1), runs the fix pass, writes WARMDOWN + HANDOFF + STATE updates, commits the fix-pass and closeout commits. Owns the final diff.
- **IC worker (`cursor`, default)** = primary implementer. Phase A only. Writes code, tests, docs against one story brief, runs the local build / test, **commits atomically** before exiting. Fresh process per story; never carries context across stories.
- **Spec + code-quality gate worker (`pi`)** = peer-IC who fact-checks the team's work after Phase A. Reads every brief + the sprint diff, walks acceptance criteria, scans code quality. Writes `gate-sprint.md` with verdict. **NOT adversarial** — same team as the IC; the gate exists so the team isn't scolded by the manager for things the IC could have caught.
- **Adversarial second-opinion reviewer (`codex`)** = strongest spec + quality + adversarial gate. Phase B only, only when source/test code shipped. Reads diff + gate + r1; finds non-obvious bugs (race conditions, type holes, untested paths, hidden coupling). Critiques r1 itself if wrong. Independent fourth voice.

The roles never collapse. Each role is a different worker by design.

---

## Commits

The commit graph for one sprint looks like:

```
[S{N}-01] story 1 title         <- fresh cursor commits
[S{N}-02] story 2 title         <- fresh cursor commits
...
[S{N}-mm] story mm title        <- fresh cursor commits
[S{N}-fix] phase B fix pass     <- manager commits (folds in gate / r1 / r2 fixes + sprint planning docs)
[S{N}-close] WARMDOWN + HANDOFF + STATE pointing to sprint N+1     <- manager commits
```

Cursor commits its own implementation work. Pi and codex never commit — manager stages their reports during the fix pass. Manager is the only role with commit authority for fix and closeout commits.

---

## What lives where

| You want to know... | Read... |
|---------------------|---------|
| What's the plan? | [`WBS.md`](./WBS.md) |
| What sprint are we in? | [`STATE.md`](./STATE.md) |
| How does a session run? | [`SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md) |
| What did sprint N do? | `sprint-{N}/WARMDOWN.md` |
| What does sprint N+1 need to know? | `sprint-{N}/HANDOFF.md` |
| Why was decision X made? | `sprint-{N}/review-sprint-r1.md` + `gate-sprint.md` + `review-sprint-r2.md` (or RFC commit body for amendments) |
| What's an artifact look like? | [`templates/`](./templates/) |
