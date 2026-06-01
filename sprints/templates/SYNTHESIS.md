# Synthesis — `S{N}-{nn}` {title}

> **Note on usage.** Under the sprint-level review cadence, the manager's fix pass is captured in the `[S{N}-fix]` commit body and the WARMDOWN — synthesis-per-story is **not** the default flow. Use this template only for **one-off out-of-loop stories** that the manager runs outside the sprint cadence (e.g., an emergency hotfix between sprints), or as historical record for sprints that ran under the legacy per-story cadence.

> **Owner (main session):** {model + timestamp}.
> **Inputs:** [r1](./review-{story}-r1.md), [r2](./review-{story}-r2.md), the IC's diff.
> **Output:** the final fix list and ownership for each item. **You own the final diff.**

---

## 1. Item-by-item disposition

For every item raised in the gate (if applicable), r1, and r2, decide:

- **Apply now** — fix in this sprint, before close. Owner: you (direct edit) or a focused `cursor` fix pass.
- **Defer to backlog** — note the WBS backlog id; explain why deferring is safe.
- **Reject** — name the reason; cite the rule that backs you.

| ID | Source | Severity | Disposition | Owner | Rationale |
|----|--------|----------|-------------|-------|-----------|
| B1 | r1 | blocker | Apply now | main session | ... |
| B2 | r1 | blocker | Apply now | cursor (fix pass) | ... |
| M1 | r1 | major | Apply now | main session | ... |
| M2 | r1 | major | Defer | backlog BL-{id} | The fix is correct but adds 2 days; not in scope for this sprint. |
| m1 | r1 | minor | Reject | — | This is a style preference; no spec violation. |
| R2-1 | r2 | blocker | Apply now | main session | r2 caught a race condition r1 missed. |
| R2-2 | r2 | major | Apply now | main session | ... |
| R2-3 | r2 | minor | Defer | backlog BL-{id} | ... |
| R2-A | r2 critique of r1 | — | Acknowledged | — | r1 was wrong on item X; severity upgraded to major and applied. |

---

## 2. Fix plan

Order matters. Tackle blockers first; majors second; minors last.

### 2.1 Direct edits (main session owns)

- [ ] {fix description, file:line}
- [ ] {fix description, file:line}

### 2.2 `cursor` fix pass (delegated)

- Brief: [`brief-{story}-fix.md`](./brief-{story}-fix.md) — references the items above. Cursor commits the fix atomically with `[S{N}-fix-{nn}] {description}` before exiting.

### 2.3 Verification

- [ ] CI green after fixes.
- [ ] All `Apply now` items above ticked.
- [ ] Manual demo recording re-recorded if user-visible behavior changed.
- [ ] PR description updated with the synthesis link.

---

## 3. Backlog deltas

New backlog entries created from deferrals:

| New backlog id | Description | Earliest sprint | Source |
|----------------|-------------|-----------------|--------|
| BL-{id} | ... | v1.1 | M2 deferral |
| BL-{id} | ... | v1.1 | R2-3 deferral |

Add these rows to `sprints/WBS.md §4` at warm-down.

---

## 4. RFC / wiki amendments needed

Did the synthesis surface a need to amend a spec? List here. Each amendment is its own PR alongside the story.

- {amendment description, file, section}

If none: write "No RFC / wiki amendments needed." That is also valid.

---

## 5. Closeout

The story `S{N}-{nn}` is closed when:

- [ ] Every `Apply now` item above is resolved and verified.
- [ ] PR is open with the demo artifact, the DoD checklist ticked, and links to brief / r1 / r2 / synthesis.
- [ ] Backlog rows added to WBS.
- [ ] RFC / wiki amendments (if any) are merged.

When closed, mark the story `Done` in `sprints/sprint-{N}/PLAN.md` and proceed to the next story.
