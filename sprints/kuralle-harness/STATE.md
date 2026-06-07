# STATE — kuralle-harness program

**Active sprint:** — PROGRAM COMPLETE (all 4 ship gates green)
**Status:** Ready for release. Awaiting user approval to version + `pnpm publish -r` the graph together.
**Build branch:** `feat/kuralle-harness` (S1 `32c0ab5`, S2 `fc6adee`, S3 `9e3dd31`, S4 `445d49c` + closeout)
**IC worker:** cursor

## Sprint ledger
| Sprint | Phase / RFC | State |
|--------|-------------|-------|
| 1 | Phase 0 — rfc-01-tool-model-cleanup | ✅ DONE — Gate 01 GREEN @ `32c0ab5` |
| 2 | Phase 1 — rfc-02-filesystem-primitive | ✅ DONE — Gate 02 GREEN @ `fc6adee` (manager fix: broke core↔fs cycle) |
| 3 | Phase 2 — rfc-03-knowledgefs-rag | ✅ DONE — Gate 03 GREEN @ `9e3dd31` (live multi-page grep+cat KB answer) |
| 4 | Phase 3 — rfc-04-skills-and-scripts | ✅ DONE — Gate 04 GREEN @ `445d49c` |
| 5 | CompositeFileSystem (mount table) | ✅ DONE — Gate GREEN @ `c3356bc` (workerd parity + live /docs+/scratch smoke) |
| 6 | DB-backed + CF-native working memory | ✅ DONE — Gate GREEN @ `3bbb54d` (5 stores; CF SqlPersistentMemoryStore + workerd test) |

## Load-bearing docs for the active sprint
1. `rfcs/kuralle-harness/rfc-04-skills-and-scripts.md` (the contract — read end to end)
2. `research/skills-and-scripts-plan.md`; `research/flue/packages/runtime/src/skill-frontmatter.ts` (frontmatter limits)
3. `packages/kuralle-core/src/capabilities/index.ts` (`Capability` = `getTools()` + `getPromptSections()`) + `capabilities/AutoRetrieveCapability.ts` (on-demand-tool pattern to copy)
4. `packages/kuralle-core/src/types/filesystem.ts` (`FileSystem` for `FsSkillStore`)

## Exit gate for Sprint 4 (Gate 04)
`@kuralle-agents/skills`: SKILL.md + 3-level progressive disclosure via `SkillsCapability`; `AgentConfig.skills`; Scripts = allow-listed durable tools (no bash); `MemorySkillStore` identical Node+workerd; `test:skill-*` green; live smoke loads a skill on demand + runs a script tool; `typecheck:all`+`test` green.

## Next action
Manager: Sprint 4 delegated to cursor (brief `.handoff/brief-kh-sprint4.md`). On sentinel → diff review → run Gate 04 → proceed-evidence → PROGRAM CLOSE (changesets + version graph together; await user approval before `pnpm publish -r`).

## Cross-cutting refinement logged (post-program)
ADR-0001: workspace tool (has write/edit) auto-added to globalTools in S3-C4. Safe for read-only KnowledgeFs; for read-write workspaces make read-only the visibility default (`workspace?: { fs; readOnly? }`). Small RFC-02 amendment after the program.

## Note for live smokes
Example model resolver (`examples/_shared/v2Runner.ts`) hardcodes stale ids (gemini-2.0-flash 404, grok-2-1212). Force a working provider with `KURALLE_EXAMPLE_PROVIDER=openai` (OPENAI_API_KEY present). Pre-existing; tiny follow-up to bump ids.
