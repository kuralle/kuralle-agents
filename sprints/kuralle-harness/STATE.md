# STATE — kuralle-harness program

**Active sprint:** 1 — Phase 0: Tool model cleanup (RFC-01)
**Status:** Phase A (implementation) — delegating to cursor
**Build branch:** `feat/kuralle-harness` (baseline `9ee7241`, all commits here; no publish until program close)
**IC worker:** cursor

## Sprint ledger
| Sprint | Phase / RFC | State |
|--------|-------------|-------|
| 1 | Phase 0 — rfc-01-tool-model-cleanup | IN PROGRESS (Phase A) |
| 2 | Phase 1 — rfc-02-filesystem-primitive | BLOCKED on Gate 01 |
| 3 | Phase 2 — rfc-03-knowledgefs-rag | BLOCKED on Gate 02 |
| 4 | Phase 3 — rfc-04-skills-and-scripts | BLOCKED on Gate 02 |

## Load-bearing docs for the active sprint
1. `rfcs/kuralle-harness/rfc-01-tool-model-cleanup.md` (the contract — read end to end)
2. `rfcs/kuralle-harness/README.md` (program ship gates + guiding light)
3. `research/tools-vs-effecttools-analysis.md` (why; file:line grounding)
4. `sprints/kuralle-harness/WBS.md` (this program's WBS)

## Exit gate for Sprint 1 (Gate 01)
`bun run typecheck:all` + `bun run test` green; `scripts/check-no-raw-tool-execute.sh` green; `test:journal-key-workers` green; live smoke `bun packages/kuralle-core/examples/agents/echo.ts`; raw `tools?: ToolSet` removed; no permanent `effectTools` alias.

## Next action
Manager: review the Sprint-1 cursor diff on return → run Gate 01 → proceed-evidence → advance to Sprint 2.
