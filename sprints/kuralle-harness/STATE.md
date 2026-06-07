# STATE — kuralle-harness program

**Active sprint:** 2 — Phase 1: FileSystem primitive (RFC-02)
**Status:** Phase A (implementation) — delegating to cursor
**Build branch:** `feat/kuralle-harness` (baseline `9ee7241`; Sprint 1 closed at `32c0ab5`; no publish until program close)
**IC worker:** cursor

## Sprint ledger
| Sprint | Phase / RFC | State |
|--------|-------------|-------|
| 1 | Phase 0 — rfc-01-tool-model-cleanup | ✅ DONE — Gate 01 GREEN @ `32c0ab5` (see sprint-1/review-sprint.md) |
| 2 | Phase 1 — rfc-02-filesystem-primitive | IN PROGRESS (Phase A) |
| 3 | Phase 2 — rfc-03-knowledgefs-rag | BLOCKED on Gate 02 |
| 4 | Phase 3 — rfc-04-skills-and-scripts | BLOCKED on Gate 02 |

## Load-bearing docs for the active sprint
1. `rfcs/kuralle-harness/rfc-02-filesystem-primitive.md` (the contract — read end to end)
2. `rfcs/kuralle-harness/README.md` (program ship gates + guiding light)
3. `research/filesystem-primitives-plan.md` + `research/_sources/web/mintlify-chromafs.md`
4. `research/cloudflare-agents-sdk/packages/shell/src/fs/*` (design to re-author from)

## Exit gate for Sprint 2 (Gate 02)
`@kuralle-agents/fs` builds + dry-run-publish clean (no `.map`, no `node:*` in portable entrypoints); fs tool round-trips `ls/cat/grep/find/read/write/edit` on Node AND in vitest-pool-workers; `AgentConfig.workspace` auto-registers the tool; `bun run typecheck:all` + `test` green.

## Next action
Manager: Sprint 2 delegated to cursor (brief `.handoff/brief-kh-sprint2.md`). On sentinel → proof gate → diff review → run Gate 02 → proceed-evidence → advance to Sprint 3.

## Note for live smokes
Example model resolver (`examples/_shared/v2Runner.ts`) hardcodes stale ids (gemini-2.0-flash 404, grok-2-1212). Force a working provider with `KURALLE_EXAMPLE_PROVIDER=openai` (OPENAI_API_KEY present). Pre-existing; tiny follow-up to bump ids.
