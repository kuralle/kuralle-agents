# Program: kuralle-core as a conversational agentic harness

**Status:** Draft · **Date:** 2026-06-07 · **Baseline:** `9ee7241` (all packages 0.5.0)
**Source research:** `research/BLUEPRINT-whats-next.md`, `research/fs-skills-harness-synthesis.md`, `research/tools-vs-effecttools-analysis.md` (all file:line-verified).

A coordinated four-RFC cut that closes the gap between kuralle-core and a Pi-class conversational harness: clean the tool model, add a portable filesystem primitive, expose a knowledge base as a filesystem, and add Skills/Scripts.

## RFCs (ship order)

| # | RFC | Phase | Category | Depends on | Approx LOC | Ships |
|---|-----|-------|----------|------------|-----------|-------|
| 01 | [`rfc-01-tool-model-cleanup.md`](./rfc-01-tool-model-cleanup.md) | 0 | Architectural Change (breaking, pre-1.0) | — | ~300 (incl. wide rename) | Sprint 1 |
| 02 | [`rfc-02-filesystem-primitive.md`](./rfc-02-filesystem-primitive.md) | 1 | New Feature (new pkg `@kuralle-agents/fs`) | 01 | ~400 | Sprint 2 |
| 03 | [`rfc-03-knowledgefs-rag.md`](./rfc-03-knowledgefs-rag.md) | 2 | New Feature (`@kuralle-agents/rag` adapter) | 02 | ~250 | Sprint 3 |
| 04 | [`rfc-04-skills-and-scripts.md`](./rfc-04-skills-and-scripts.md) | 3 | New Feature (new pkg `@kuralle-agents/skills`) | 02 | ~350 | Sprint 4 |

## Dependency graph

```
01 tool-model-cleanup  (THE tool field becomes durable; raw ToolSet removed; Workers crypto fixed)
        |
        v
02 @kuralle-agents/fs   (FileSystem interface + InMemoryFs + fs tool + AgentConfig.workspace)
        |
   +----+----+
   v         v
03 KnowledgeFs   04 @kuralle-agents/skills
   (RAG-backed     (SKILL.md + SkillsCapability;
    read-only fs)   FsSkillStore rides on 02)
```

03 and 04 both depend on 02; they are independent of each other but ship sequentially (Sprint 3 then Sprint 4) per the program plan.

## Ship gates (each must be green before the next sprint starts)

- **Gate 01:** `bun run typecheck:all` green; `bun run test` green; the new `scripts/check-no-raw-tool-execute.sh` guard passes; a live smoke of an effect-tool agent on both Node (hono-server) and a CF build still works; `effectTools` no longer referenced anywhere except a back-compat deprecation alias (or fully removed). No `node:crypto` import remains on the durable-journal hot path without a WebCrypto fallback.
- **Gate 02:** `@kuralle-agents/fs` builds and publishes-dry-run clean (no `node:*` in the core interface/InMemoryFs); fs tool round-trips `ls/cat/grep/find/read/write/edit` against `InMemoryFs` in a live example on Node AND inside a Workers (`workerd`/vitest-pool-workers) test; `AgentConfig.workspace` auto-registers the fs tool; `typecheck:all` + `test` green.
- **Gate 03:** `KnowledgeFs` read-only adapter over an existing RAG store passes a live test where an agent answers a question by `grep`+`cat` over bundled docs; writes throw `EROFS`; RBAC tree-prune verified; `typecheck:all` + `test` green.
- **Gate 04:** a `SKILL.md` skill loads via 3-level progressive disclosure (metadata in prompt, body on `load_skill`, resource on read); a "script" (allow-listed effect tool) executes through the journal; `MemorySkillStore` runs byte-identically on Node and CF; `typecheck:all` + `test` green.

## What this program explicitly does NOT ship

- Real bash/shell in core (Pi `ExecutionEnv.Shell` seam noted, deferred to a later Node-only RFC).
- Multi-agent sub-dispatch (rejected: "consolidate the brain").
- Proactive usage-driven compaction, `RecoveryPolicy`, session-tree (`parentId`) — Phase 4 of the blueprint, separate future RFCs.
- Any new session-storage format, TUI/CLI.

## Program acceptance criteria

When all four have shipped: a developer can `defineAgent({ workspace: someFileSystem, skills: [...] })`, the agent explores a local knowledge base via `ls/cat/grep`, loads Skills on demand, runs Scripts as durable (exactly-once) effect tools, every tool goes through the durable journal, and the whole thing runs on Node (hono-server) and Cloudflare Workers (cf-agent). One tool concept (`tools` = durable) + `globalTools` (visibility) — no silent non-durable path.

## Guiding light (cross-cutting decisions every RFC obeys)

1. **One durable tool concept.** Every tool is a `defineTool` effect tool routed through the `ctx.tool`/`replayOrExecute` journal. Third-party AI SDK tools enter only via `wrapAiSdkTool()`.
2. **Interface in core, one `node:*` boundary in the adapter.** No `node:*` in `kuralle-core` or in any portable interface/InMemory impl. Workers parity is a gate, not an afterthought.
3. **Additive + minimal.** Copy a proven design (named per RFC) rather than invent. One new `AgentConfig` field per capability, merged through the existing `globalTools`/executor path.
4. **Breaking is acceptable pre-1.0** (RFC-01 only) when it produces the correct end state; no compat shims kept as permanent debt.
5. **Never claim done without proof.** Each sprint ends on a green gate above + an observed live smoke, not "should work."

## Execution

Each RFC's **Section 8** is the sprint WBS. Run `/rfc-to-sprints` per RFC to expand into the sprint OS under `.handoff/`, then `/delegate --to cursor` the sprint with the RFC as binding contract. Sequential: Sprint 1 → 2 → 3 → 4, verifying each ship gate before advancing.

## Where to start reading
- 5-min skim: this README + each RFC's Section 1 + Section 8.
- Implementer (IC): read the target RFC end-to-end, then its Section 8 row-by-row; the RFC is the contract.
- Reviewer: Section 3 (REQ) + Section 4 (interfaces) + Section 9 (validation).
