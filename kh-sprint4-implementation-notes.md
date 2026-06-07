# kh-sprint4 — implementation notes

## Decisions

- **Q1 (sync `getPromptSections`):** Confirmed sync at `capabilities/index.ts:92`. `SkillsCapability` pre-loads `SkillMeta[]` at construction via `wireAgentSkills` awaiting `store.list()` first.
- **Q2 (YAML):** Minimal `---` fence splitter + line parser (no `js-yaml` in tree). Supports quoted strings and `|` block scalars for `description`.
- **Q3 (bash scripts):** Rejected per RFC — `allowedTools` only; wire-time validation against `tools`/`globalTools`/`flows[].name`.
- **Build cycle (core ↔ skills):** `SkillSource` types live in `kuralle-core/src/types/skills.ts` (mirrors `FileSystem` pattern). Runtime uses dynamic `import('@kuralle-agents/skills')` + `skills-bridge.d.ts` ambient module. `wireAgentSkills` accepts `SkillWireAgent` to avoid src/dist `AgentConfig` drift in test tsconfig.

## Root cause fixed

- Dual `PromptSection` types in core (`prompts/types` vs `capabilities/index`) — `SkillsCapability` imports from `@kuralle-agents/core/capabilities`.

## Unverified

- None for Gate 04 scope. Live smoke observed: `load_skill` + `lookup_order` on `support-skill.ts` with OpenAI.
