# Proceed Evidence — `S4-02` docs + ADR-0004

> Manager artifact — Phase A.

## Story
- **Id:** `S4-02` · **Commit:** `77cf7e8` · **IC:** cursor (`stream-s4-02`)

## Checklist
- [x] `verify-handoff-proof.sh stream-s4-02` → PROOF_OK (3 claims, 4 assertions) **after manager repaired an invalid-JSON escape** in the embedded grep command (`\.`/`\0` unescaped); substance independently verified.
- [x] **ADR-0004 present + thorough** (`docs/adr/0004-streaming-by-default.md`): decision, shared `speakGated` path, mode table (token/sentence/turn), breaking lifecycle, REQ-9 native-realtime advisory, 0.4.0 note.
- [x] **Docs grep-clean** — no `part.text` left in `apps/docs`/`docs`/`README.md`/package READMEs/`docs/skills` (assistant-text event references migrated to `part.delta`).
- [x] RFC edit benign (1 line: a part.text→part.delta example). Guard: no new typecheck:all failures. No suppression.

**Verdict:** `PROCEED`

## One-line
ADR-0004 + all public docs migrated to the text-start/delta/end lifecycle (part.delta); REQ-9 advisory documented · `77cf7e8`.
