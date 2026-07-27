---
type: verifier
command: bun run test
enabled: true
---

# Tests pass

Runs every package's suite. `bun run test` fans out via `--filter '*'`; `npm test`
resolves to the same script, so either works — this uses bun to match how the repo
is developed.

Exit code 0 means pass. Note what a green suite does *not* prove: that a test for
the requirement exists at all. `protocol.md` covers that separately — diff the
per-package test counts against the pre-dispatch baseline, because a requirement
whose package gained zero tests is unproven however green the run.
