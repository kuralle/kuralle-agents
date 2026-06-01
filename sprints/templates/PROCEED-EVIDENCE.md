# Proceed Evidence — `S{N}-{nn}` {title}

> **Manager artifact — Phase A only.** Confirms this story may proceed to the next story. **Not a gate worker review.** Full pi / r1 / r2 gates run only in **Phase B** after every story in the sprint is committed.

---

## Story

- **Id:** `S{N}-{nn}`
- **Commit:** `{sha}` — `[S{N}-{nn}] {title}`
- **IC slug:** `{slug}` (`.handoff/brief-{slug}.md`)

---

## Proceed checklist (manager — read diff, do not trust IC chat)

- [ ] Diff read — scope matches brief §3 file list
- [ ] `.handoff/proof-{slug}.json` exists
- [ ] `~/.agents/scripts/verify-handoff-proof.sh {slug}` → `PROOF_OK`
- [ ] `validation_contract.assertions_satisfied` equals `assertions_required` (if present)
- [ ] Demo artifact path from brief exists (if required)
- [ ] No `--no-verify` / type-suppression in diff

**Verdict:** `PROCEED` | `HOLD` (do not start next story until fixed)

**If HOLD:** re-delegate IC with fix brief — do **not** invoke pi gate or codex r2 mid-sprint.

---

## One-line summary

{What shipped · proof slug · commit sha}

---

## Notes

{Optional: drift, RFC amendment needed, trap for next story}
