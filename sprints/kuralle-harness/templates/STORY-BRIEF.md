# Sprint {N} IC brief — {phase title} (RFC-{NN})

> Prefixed automatically by `/delegate` with the ship-it + autonomous-stand IC contracts. This is the task brief.

## Mission
Implement **all of `rfcs/kuralle-harness/rfc-{NN}-*.md`** (the binding contract) on branch `feat/kuralle-harness`. Read the RFC end to end FIRST, then implement Section 8 chunks **C1..Cn in order**. Commit atomically per chunk: `[kh-S{N}-C{i}] <chunk title>`.

## Read these first (conventions + grounding)
- `rfcs/kuralle-harness/rfc-{NN}-*.md` (contract: REQ, interfaces §4, blueprint §7, WBS §8, validation §9, hard-stops §11)
- `rfcs/kuralle-harness/README.md` (program guiding light + Gate 0{phase})
- The neighbour files cited in the RFC's §4/§7 (match existing style exactly)
- `CLAUDE.md` (monorepo rules: stale-dist rebuild, no `.map`, no `node:*` in portable code, version+publish together)

## Definition of Done (the sprint ship gate — observe, don't assume)
- Every RFC §8 chunk implemented + committed atomically on `feat/kuralle-harness`.
- RFC §9.1 fail-to-pass tests green; §9.2 regression green.
- `bun run build && bun run typecheck:all && bun run test` green.
- The sprint's demoable live smoke (RFC §9.3 / WBS §2) was RUN and observed to work.
- Docs/changeset updated (RFC §8 docs chunk).
- Write proof JSON `.handoff/proof-kh-sprint{N}.json` (commands run + results) and the sentinel `.handoff/result-kh-sprint{N}.done`.

## Constraints
- Do NOT touch packages/files outside the RFC's scope.
- Do NOT publish, do NOT version-bump beyond a changeset, do NOT merge to `main`.
- No workarounds: no `@ts-ignore`, no `--no-verify`, no skipped tests. If blocked by a §11 hard-stop, write `.handoff/blocked-kh-sprint{N}.md` and STOP.
- Rebuild a package after editing its `src/` before testing dependents (stale-dist gotcha).
