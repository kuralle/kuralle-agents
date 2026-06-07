# Sprint 4 review + proceed — Phase 3: Skills & Scripts (RFC-04)

**IC:** cursor · **Range:** `09a44b9..445d49c` (8 IC commits `kh-S4-C1..C8` + 1 manager-directed fix `kh-S4-fix`) · **Decision: PROCEED → PROGRAM COMPLETE.**

## Gate 04 results (manager-run, observed)
| Check | Result |
|-------|--------|
| `bun run build` + `typecheck:all` + playground | ✓ green |
| full `bun run test` | 0 fail |
| skills tests (parse/stores/fs-store/capability/agent + workers) | 13 pass + workers pass, 0 fail |
| CI guard (S1) | ✓ still green |
| cycle broken | no `await import` in core; no `@kuralle-agents/skills` in core src/pkg.json; `skills-bridge.d.ts` deleted |
| **live smoke (observed)** | `KURALLE_EXAMPLE_PROVIDER=openai bun .../examples/support-skill.ts` → `tool calls: [load_skill, lookup_order]`; agent loaded a skill on demand (progressive disclosure) then ran an allow-listed Script (durable tool), answering with skill policy ("30-day window") + script data ("delivered 12 days ago → returnable") |

## Layer 1 — What works
- `@kuralle-agents/skills`: `defineSkill`, `parseSkillMarkdown` (name≤64/desc≤1024), `Memory`/`Bundled`/`Fs` skill stores, `SkillsCapability` (Level-1 name+desc in prompt; `load_skill`/`read_skill_resource` on-demand tools — the `AutoRetrieveCapability` pattern), `AgentConfig.skills`.
- Scripts = allow-listed durable tools (no bash), validated at wire time.
- 3-level progressive disclosure + Script execution observed live end-to-end.

## Layer 2 — Blockers (found + fixed)
- **Repeat of the Sprint-2 anti-pattern:** the IC wired `AgentConfig.skills` via a dynamic `await import('@kuralle-agents/skills')` + ambient `skills-bridge.d.ts` + core→skills dep (cycle). Fresh cursor session — no memory of `kh-S2-fix`. Re-delegated with an airtight brief referencing `kh-S2-fix`; the fix (`kh-S4-fix`) moved `SkillsCapability` + `wireAgentSkills` into core (`src/skills/`), inlined the `Skill[]→store` conversion, kept the rich stores/parser in the package, static-imported in Runtime, deleted the ambient decl, removed the core dep, and re-exported the bridge from `@kuralle-agents/skills`. Re-verified green.
- Note: `verify-handoff-proof.sh kh-sprint3` schema nit (cosmetic) and the ADR-0001 workspace-visibility refinement remain logged for post-program (WBS risks).

## Verdict
Solid (after manager fix). Gate 04 GREEN. **Program complete — all four ship gates met.**

## Process learning (for the program closeout)
Fresh IC sessions don't carry prior-sprint fixes. When a structural pattern is fixed once (e.g. the core↔package cycle), bake it into the NEXT sprint's brief proactively ("packages that depend on core must not be imported by core; put the runtime bridge in core, implementations in the package — see kh-S2-fix"). The S4 brief lacked that note; the S3 brief got the createFsTool-location note and avoided trouble.
