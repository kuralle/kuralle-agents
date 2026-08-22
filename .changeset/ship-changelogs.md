---
"@kuralle-agents/core": patch
---

Ship `CHANGELOG.md` in every published package.

The changeset config sets `changelog: false` and no package listed a changelog in `files`, so a
release reached npm with no notes attached. 0.23.1 moved the `ai` peer range to `^7.0.0` as a patch
and had no channel to say so. Packaging only — no runtime change.
