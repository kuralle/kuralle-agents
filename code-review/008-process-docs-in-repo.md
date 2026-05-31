# 008 — Internal process docs tracked for public flip

| Field | Value |
|-------|-------|
| **Severity** | low |
| **Axis** | public-readiness |
| **Status** | open |
| **Location** | `HANDOFF.md`, `implementation-notes.md` |

## What's wrong

Session engineering records (`HANDOFF.md`, `implementation-notes.md`) are committed and will ship if the repo goes public unchanged. They contain session-internal narrative (GLM review in flight, owner key rotation reminders, commit archaeology).

## Evidence

Both files are tracked on `main`. Author disclosed in `implementation-notes.md` D8 and `HANDOFF.md` pending section.

## Recommendation

Owner decision before public flip: `git rm` + add to `.gitignore`, or move to `.handoff/` (already gitignored pattern may vary). Not a code defect.
