# STATE — kuralle-harness program

**Active sprint:** 3 — Phase 2: KnowledgeFs over RAG (RFC-03)
**Status:** Phase A (implementation) — delegating to cursor
**Build branch:** `feat/kuralle-harness` (baseline `9ee7241`; S1 @ `32c0ab5`, S2 @ `fc6adee`; no publish until program close)
**IC worker:** cursor

## Sprint ledger
| Sprint | Phase / RFC | State |
|--------|-------------|-------|
| 1 | Phase 0 — rfc-01-tool-model-cleanup | ✅ DONE — Gate 01 GREEN @ `32c0ab5` |
| 2 | Phase 1 — rfc-02-filesystem-primitive | ✅ DONE — Gate 02 GREEN @ `fc6adee` (manager fix: broke core↔fs cycle) |
| 3 | Phase 2 — rfc-03-knowledgefs-rag | IN PROGRESS (Phase A) |
| 4 | Phase 3 — rfc-04-skills-and-scripts | UNBLOCKED (after Gate 02); runs as Sprint 4 |

## Load-bearing docs for the active sprint
1. `rfcs/kuralle-harness/rfc-03-knowledgefs-rag.md` (the contract — read end to end)
2. `research/_sources/web/mintlify-chromafs.md` (the pattern)
3. `packages/kuralle-rag/src/types.ts` (`KnowledgeChunk`, `VectorStoreCore`, `VectorFilter`) + `search/` (`BM25Index`)
4. `packages/kuralle-core/src/types/filesystem.ts` (`FileSystem` interface to implement) + `createFsTool` (note: now in CORE, re-exported by `@kuralle-agents/fs`; the `fs.search` coarse hook is the integration point)

## Exit gate for Sprint 3 (Gate 03)
`KnowledgeFs` read-only FileSystem over `VectorStoreCore`: `cat`=chunk reassembly, `grep`=coarse→fine, writes→`EROFS`, RBAC tree-prune; `test:kfs-*` green; agent answers a multi-page question via grep+cat (live smoke); `typecheck:all`+`test` green.

## Next action
Manager: Sprint 3 delegated to cursor (brief `.handoff/brief-kh-sprint3.md`). On sentinel → proof gate → diff review → run Gate 03 → proceed-evidence → advance to Sprint 4.

## Note for live smokes
Example model resolver (`examples/_shared/v2Runner.ts`) hardcodes stale ids (gemini-2.0-flash 404, grok-2-1212). Force a working provider with `KURALLE_EXAMPLE_PROVIDER=openai` (OPENAI_API_KEY present). Pre-existing; tiny follow-up to bump ids.
