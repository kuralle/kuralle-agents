# WBS — kuralle-core as a conversational agentic harness

**Source RFCs:** `rfcs/kuralle-harness/` (program README + `rfc-01..04`), grounded in `research/BLUEPRINT-whats-next.md`, `research/fs-skills-harness-synthesis.md`, `research/tools-vs-effecttools-analysis.md`.
**Build branch:** `feat/kuralle-harness` · **Baseline:** `9ee7241` (all packages 0.5.0).
**IC worker:** cursor (Phase A implementation).

## 1.1 Cadence
One sprint per RFC/phase (4 sprints total, sequential — the dependency graph forbids parallelism: `01 → 02 → {03,04}`). Each sprint: Phase A (IC implements all chunks via `/delegate --to cursor`, atomic commits per chunk) → manager proceed-evidence → Phase B (manager adversarial diff review + fix pass) → ship gate → next sprint. No Sprint 0, no polish sprint: the user scoped exactly 4 phases = 4 sprints.

## 1.2 Roadmap

| Sprint | Phase | RFC | Goal (verifiable outcome) |
|--------|-------|-----|---------------------------|
| 1 | 0 — Tool model cleanup | `rfc-01-tool-model-cleanup.md` | One durable tool concept: `AgentConfig.tools` (effect tools) + `globalTools`; raw `ToolSet` field removed; `wrapAiSdkTool` interop; CI guard blocks un-journaled `execute`; journal keying verified on Workers. `typecheck:all`+`test` green. |
| 2 | 1 — FileSystem primitive | `rfc-02-filesystem-primitive.md` | `@kuralle-agents/fs` (portable `FileSystem` + `InMemoryFs`, zero `node:*`) + one durable `workspace` tool (`ls/cat/grep/find/read/write/edit`) + `AgentConfig.workspace`. Round-trips on Node and in workerd. |
| 3 | 2 — KnowledgeFs over RAG | `rfc-03-knowledgefs-rag.md` | `KnowledgeFs` read-only `FileSystem` over `VectorStoreCore`: a support agent answers a multi-page question via `grep`+`cat`; writes → `EROFS`; RBAC tree-prune. |
| 4 | 3 — Skills & Scripts | `rfc-04-skills-and-scripts.md` | `@kuralle-agents/skills`: `SKILL.md` + 3-level progressive disclosure via `SkillsCapability`; `AgentConfig.skills`; Scripts = allow-listed durable tools. `MemorySkillStore` identical on Node + workerd. |

## 1.3 RFC → sprint mapping
Each sprint implements exactly one RFC; the RFC's **Section 8** is the sprint's story list (chunks C1..Cn), its **Section 9** is the sprint's acceptance/test contract, and its **Section 11** is the sprint's hard-stop list. The program README ship gate (Gate 01..04) is the sprint exit gate.

## 2. Sprints

### Sprint 1 — Phase 0: Tool model cleanup (RFC-01)
Stories = RFC-01 §8 C1–C7. Demoable outcome: a shipped effect-tool example runs end-to-end on Node and a CF build; `scripts/check-no-raw-tool-execute.sh` green; `effectTools` gone (renamed to `tools`).
- **DoD (Gate 01):** `bun run typecheck:all` + `bun run test` green; CI guard passes; `test:journal-key-workers` green; live smoke `bun packages/kuralle-core/examples/agents/echo.ts`; no raw `tools?: ToolSet` field remains; no permanent `effectTools` alias.
- **Hard stops:** RFC-01 §11 (journal key can't be made Workers-identical without `node:*`; a non-`agentReply` flow path breaks on field removal).

### Sprint 2 — Phase 1: FileSystem primitive (RFC-02)
Stories = RFC-02 §8 C1–C8. Demoable: `bun packages/kuralle-fs/examples/kb-agent.ts` lists+reads bundled docs.
- **DoD (Gate 02):** package builds + dry-run-publish clean (no `.map`, no `node:*` in portable entrypoints); fs tool round-trips on Node AND in vitest-pool-workers; `AgentConfig.workspace` auto-registers the tool; `typecheck:all`+`test` green.
- **Hard stops:** RFC-02 §11.

### Sprint 3 — Phase 2: KnowledgeFs over RAG (RFC-03)
Stories = RFC-03 §8 C1–C7. Demoable: `bun packages/kuralle-rag/examples/support-kb-agent.ts` answers a multi-page question via grep+cat.
- **DoD (Gate 03):** `test:kfs-*` green (cat reassembly, EROFS, grep two-stage, RBAC prune, agent e2e); `typecheck:all`+`test` green.
- **Hard stops:** RFC-03 §11 (store lacks page/chunk_index metadata; RBAC traversal bypass).

### Sprint 4 — Phase 3: Skills & Scripts (RFC-04)
Stories = RFC-04 §8 C1–C8. Demoable: `bun packages/kuralle-skills/examples/support-skill.ts` loads a skill on demand + runs an allow-listed script tool through the journal.
- **DoD (Gate 04):** `test:skill-*` green incl. workers parity + e2e; `typecheck:all`+`test` green.
- **Hard stops:** RFC-04 §11 (Capability signature mismatch; allowedTools validation can't see the registry).

## 3. Universal Definition of Done (every sprint)
1. Every RFC §8 chunk for the sprint is implemented and committed atomically on `feat/kuralle-harness`.
2. The sprint's RFC §9 fail-to-pass tests are green; §9.2 regression suites stay green.
3. `bun run typecheck:all` and `bun run test` green (the standing gate).
4. A live smoke (the sprint's demoable command) was *observed* to work — not "should work".
5. Docs/changeset updated in the same sprint (no doc drift).
6. Manager reviewed the **git diff** (not just the digest) and wrote proceed-evidence.

## 4. Backlog (explicit non-goals — deferred to future RFCs)
| Item | Source |
|------|--------|
| Real bash/shell in core (Pi `ExecutionEnv.Shell` seam) | program README; RFC-04 Q3 |
| Multi-agent sub-dispatch | rejected — "consolidate the brain" |
| Proactive usage-driven compaction; `RecoveryPolicy`; session-tree (`parentId`) | BLUEPRINT Phase 4 |
| Unify `globalTools` into `tools` w/ visibility flag | RFC-01 Q3 (revisit at 1.0) |

## 5. Risk register
| Risk | Detection | Mitigation |
|------|-----------|------------|
| Field rename (`effectTools→tools`) breaks 59 in-repo files | `typecheck:all` red | scripted codemod (RFC-01 C5) + manual review of raw-ToolSet collisions |
| Journal `node:crypto` not Workers-portable | `test:journal-key-workers` red | verify nodejs_compat first; WebCrypto fallback (RFC-01 C6); abort if needs `node:*` in Workers bundle |
| Stale-dist trap: cross-package interface drift (core↔fs↔rag↔skills) | `tsc` "separate declarations of a private property" | declare interfaces in core, re-export from pkgs (RFC-02 §5.2); rebuild dependents before testing |
| Publishing one package alone pins old exact deps | consumer double-install | version + `pnpm publish -r` the graph together at program close (CLAUDE.md gotcha) |
| cursor autonomous diff regresses a published framework | manager diff review + gates | sequential sprints, branch-isolated, gate-before-advance; never accept on digest alone |

## 6. Notes
- All work lands on `feat/kuralle-harness`; no publish until the program closes and the manager versions the graph together.
- Each sprint advances only after its ship gate is green. Manager owns the fix pass + closeout.
