# kuralle-harness — manager notes (program complete)

**Goal:** RFCs for Phases 0–3, then deliver the build as manager (delegate each phase to cursor, one sprint per phase, verify, ship). **Status: complete — all 4 ship gates green on `feat/kuralle-harness`.** No publish yet (gated on user approval).

## What shipped
kuralle-core is now a conversational agentic harness with a portable filesystem, a knowledge-base-as-filesystem, and Anthropic-style Skills/Scripts.

| Sprint / Phase | Outcome | Gate commit |
|---|---|---|
| 1 — Tool model cleanup (RFC-01) | One durable tool concept: `AgentConfig.tools` (effect tools) + `globalTools`; raw `ToolSet` field removed; `wrapAiSdkTool()` interop; CI guard `check-no-raw-tool-execute.sh`; Workers journal-key parity. | `32c0ab5` |
| 2 — `@kuralle-agents/fs` (RFC-02) | Portable `FileSystem` + `InMemoryFs` (zero `node:*`) + one durable `workspace` tool (ls/cat/grep/find/read/write/edit) + `AgentConfig.workspace`. Node + workerd. | `fc6adee` |
| 3 — KnowledgeFs (RFC-03) | Read-only `FileSystem` over `VectorStoreCore`: cat=chunk reassembly, grep=coarse→fine, EROFS, RBAC tree-prune. | `9e3dd31` |
| 4 — Skills & Scripts (RFC-04) | `@kuralle-agents/skills`: SKILL.md + 3-level progressive disclosure via `SkillsCapability`; `AgentConfig.skills`; Scripts = allow-listed durable tools. | `445d49c` (+ closeout) |

## Verification (manager-run, observed — not worker self-report)
Every sprint: `bun run build && typecheck:all && test` green + the sprint's targeted tests + a **live OpenAI smoke**:
- S1: `echo` agent — `echo`/`end_call` tools executed through the renamed durable path.
- S2: `kb-agent` — `workspace` tool ran ls/read/grep over InMemoryFs.
- S3: `support-kb-agent` — grounded multi-page answer via grep+cat over KnowledgeFs.
- S4: `support-skill` — `load_skill` (on-demand) → `lookup_order` Script → grounded answer.
(Live smokes require `KURALLE_EXAMPLE_PROVIDER=openai`; the example model resolver hardcodes stale ids — see follow-ups.)

## Manager interventions (fixes I made on top of worker output)
1. **`kh-S1-fix`** — codemod produced `tools?, tools?` duplicates in `CLAUDE.md` + a usage SKILL.md; restored to `tools?, globalTools?`.
2. **`kh-S2-fix`** — IC wired `AgentConfig.workspace` via a dynamic `await import('@kuralle-agents/fs')` + circular core↔fs dep + ambient `.d.ts`. Moved `createFsTool` into core (needs only `defineTool` + `FileSystem`), static import, removed the cycle, deleted the ambient decl, re-export from fs.
3. **`kh-S4-fix`** — IC repeated the same anti-pattern for skills (fresh session). Re-delegated with a brief referencing `kh-S2-fix`; moved `SkillsCapability` + `wireAgentSkills` into core, inlined `Skill[]→store`, kept rich stores/parser in the package, removed the cycle.

## Architecture invariant established
Packages that depend on `@kuralle-agents/core` must NOT be imported by core. The runtime *bridge* for an optional capability lives in core (depends only on core primitives + the capability's interface, which is core-owned); the rich *implementations* live in the satellite package, which re-exports the bridge. Applied to both fs and skills.

## Open follow-ups (logged, NOT blocking the program)
1. **ADR-0001 workspace visibility** — the `workspace` tool (has write/edit) is auto-added to `globalTools` (model-visible). Safe for read-only KnowledgeFs (EROFS); for read-write workspaces, make read-only the visibility default (`workspace?: { fs; readOnly? }`) or flow-gate mutation. Small RFC-02 amendment.
2. **Example model resolver** hardcodes stale ids (`gemini-2.0-flash` 404, `grok-2-1212`) in `packages/kuralle-core/examples/_shared/v2Runner.ts`. Bump ids; until then force `KURALLE_EXAMPLE_PROVIDER=openai`.
3. **`verify-handoff-proof.sh`** threw `KeyError: 'type'` on the S3 proof (schema variant); cosmetic — proofs are substantive.
4. **Process:** bake a fixed structural pattern into the NEXT sprint's brief proactively (the S4 cycle repeat would have been avoided).

## Release (when user approves)
Breaking: `effectTools → tools` (consumers migrate; raw `ToolSet` agent field gone → use `wrapAiSdkTool`). Changesets present per sprint (`.changeset/kh-s1..s4`). **Version + `pnpm publish -r` the whole graph together** (workspace:* exact-pin gotcha). New published packages: `@kuralle-agents/fs`, `@kuralle-agents/skills`. Do NOT publish piecemeal. Branch `feat/kuralle-harness` is ready to merge to `main` after review.
