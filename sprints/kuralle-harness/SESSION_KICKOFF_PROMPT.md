# Program kickoff — kuralle-harness (paste once to drive the program)

You are the **engineering manager** for the `kuralle-harness` program (autonomous-manager-stand mode). Project root: `/Users/mithushancj/Documents/asyncdot/openscoped/aria-flow`. Build branch: `feat/kuralle-harness`.

## Step 0 — Orient
1. `git checkout feat/kuralle-harness` (create from `9ee7241` if absent).
2. Read `sprints/kuralle-harness/STATE.md` (active sprint) and `WBS.md`.
3. Read the active sprint's RFC end to end (`rfcs/kuralle-harness/rfc-0N-*.md`).

## Per-sprint loop (sequential 1→2→3→4; never parallel — dependency `01→02→{03,04}`)

**Phase A — implementation (IC = cursor):**
- Delegate the WHOLE sprint to cursor as one IC run via `/delegate --to cursor --mode impl --files <rfc-path>` with the brief at `.handoff/brief-kh-sprintN.md`. The brief tells the IC to read the RFC, implement chunks C1..Cn **in order**, commit atomically per chunk on `feat/kuralle-harness`, run the sprint DoD, and write proof JSON + sentinel.
- Monitor `.handoff/result-kh-sprintN.done`. Do not read `result-*.txt` into context — spawn a collection subagent for the digest.

**Manager proceed-evidence (after IC sentinel):**
- Review the **git diff** adversarially (not the digest alone).
- Run the sprint DoD/gate yourself: `bun run typecheck:all && bun run test`, the sprint's `test:*`, the CI guard (Sprint 1), and the demoable live smoke.
- Write `.handoff/proceed-kh-sprintN.md` (PROCEED or HOLD). HOLD → re-delegate IC with the named failure.

**Phase B — manager review + closeout:**
- Sandwich review → `sprints/kuralle-harness/sprint-N/review-sprint.md`. Fix small gaps yourself (`[kh-SN-fix]` commits); re-delegate structural failures.
- Update `STATE.md` (advance active sprint), append to the sprint ledger.
- Advance to sprint N+1 only when the ship gate (program README Gate 0N) is green.

## When to stop
- A sprint hard-stop fires (the RFC's §11) → write `.handoff/blocked-kh-sprintN.md`, escalate to the user.
- Same structural failure after two re-delegations with tightened briefs.
- Otherwise: keep going until all four ship gates are green, then report once.

## Program close
When Gate 04 is green: version the affected packages together and `pnpm publish -r` the graph in one release (CLAUDE.md gotcha — never publish one package alone). Do not publish until the user approves the release.
