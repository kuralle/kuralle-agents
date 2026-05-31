# 003 — Duplicate public-readiness commits on `main`

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Axis** | process / git hygiene |
| **Status** | open |
| **Location** | git history: `a3fed71`, `c5cc61f` |

## What's wrong

Two consecutive commits share the same subject and nearly identical trees:

```
c5cc61f chore: public-readiness — Apache-2.0 licensing, repo metadata, residue cleanup
a3fed71 chore: public-readiness — Apache-2.0 licensing, repo metadata, residue cleanup
```

## Evidence

```bash
git diff a3fed71 c5cc61f --stat
# HANDOFF.md | 107 ++++++++++++++++++++++++++-----------------------------------------
# 1 file changed, 46 insertions(+), 61 deletions(-)
```

All code/licensing changes are in `a3fed71`; `c5cc61f` only rewrites `HANDOFF.md` again.

## Recommendation

Before pushing public or opening a release PR, **interactive rebase squash** `c5cc61f` into `a3fed71` (or drop `c5cc61f` if `a3fed71`'s HANDOFF is canonical). Not fixed in-tree — requires owner-approved history rewrite.
