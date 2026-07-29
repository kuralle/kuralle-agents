---
'@kuralle-agents/core': minor
'@kuralle-agents/fs': minor
---

Add a root-confined Node filesystem adapter for real local files. Filesystem-backed skills now fail loudly on invalid `SKILL.md` content, retain `allowed-tools` enforcement, refresh once per runtime snapshot, reuse cached bodies within that snapshot, and record a SHA-256 snapshot hash on turn traces.
