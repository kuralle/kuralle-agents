# RFC: `@kuralle-agents/skills` — Agent Skills and Scripts

**Category:** New Feature
**Author:** kuralle-harness program
**Date:** 2026-06-07
**Status:** Draft
**Reviewers:** (program)
**Related:** `research/skills-and-scripts-plan.md`, `research/_sources/transcripts/sSqzg_W8OnA.txt`, `rfcs/kuralle-harness/rfc-02-filesystem-primitive.md`
**Depends on:** RFC-02 (`FileSystem` for `FsSkillStore`); composes with RFC-01 (Scripts = durable tools).

---

## 1. Problem Statement

Kuralle has no Skills mechanism. The Anthropic Agent Skills standard — a folder + `SKILL.md` (YAML frontmatter) + 3-level progressive disclosure + bundled scripts/resources — is how Claude Code / OpenClaw / Hermes / Flue / Pi package reusable capability (`research/skills-and-scripts-plan.md`). Kuralle already has the perfect host: the `Capability` interface (`packages/kuralle-core/src/capabilities/index.ts:87`, methods `getTools()` + `getPromptSections()`) and the on-demand-tool pattern of `AutoRetrieveCapability` (`capabilities/AutoRetrieveCapability.ts`, turns retrieval into a `search_knowledge_base` tool whose result flows back to the model).

Success: a new `@kuralle-agents/skills` package + an `AgentConfig.skills?` field. Skills expose only `name`+`description` in the prompt (Level 1), load their body via a `load_skill` tool (Level 2), and read bundled resources via a `read_skill_resource` tool (Level 3). "Scripts" are allow-listed durable tools/flows (RFC-01), not bash. `MemorySkillStore` runs byte-identically on Node and Cloudflare.

## 2. Background

Cross-system (`research/skills-and-scripts-plan.md`):
- **Canonical Anthropic Agent Skills:** `SKILL.md` frontmatter `name` (≤64) + `description` (≤1024); body is markdown instructions; a folder may bundle scripts and resources; the agent loads the body only when the description matches the task (progressive disclosure).
- **Flue** implements exactly this: `packages/runtime/src/skill-frontmatter.ts` validates `name`≤64 / `description`≤1024 ("Agent Skills limit"); `examples/imported-skill/src/skills/review/SKILL.md` + `CHECKLIST.txt`. Bytes are bundled (Workers).
- **Pi** walks `node:fs` for skills (`pi/packages/agent/src/harness/skills.ts`) and emits an `<available_skills>` block (name/description/location) for lazy load via the read tool.
- **kuralle host:** `Capability.getPromptSections()` injects Level-1 metadata; `Capability.getTools()` exposes `load_skill`/`read_skill_resource` — a direct copy of the `AutoRetrieveCapability` on-demand-tool trick.

Two deliberate divergences for a *conversational* (not coding) framework:
1. Skills resolve through a `SkillStore` (no POSIX fs assumption on Workers); default `MemorySkillStore`/`BundledSkillStore` have zero `node:*`.
2. A skill's "script" references a durable `defineTool`/flow by name (allow-listed), not portable bash — respects "tools return data only / SOP in flows" and the RFC-01 journal.

## 3. Strict Requirements

- REQ-1: New package `@kuralle-agents/skills` (`packages/kuralle-skills/`) exporting `defineSkill`, `Skill` type, `parseSkillMarkdown`, `SkillStore` interface + `MemorySkillStore`/`BundledSkillStore`/`FsSkillStore`, and `SkillsCapability`.
- REQ-2: `Skill` shape: `{ name, description, body, resources?, allowedTools? }`. `defineSkill()` is a pass-through validator (mirrors `defineAgent`/`defineTool`).
- REQ-3: `parseSkillMarkdown` ports Flue's frontmatter rules (`name` required ≤64; `description` required ≤1024; YAML mapping or clear error). Cite `flue/.../skill-frontmatter.ts`.
- REQ-4: `SkillStore` interface: `list(): Promise<SkillMeta[]>` (Level-1 name+description) · `loadBody(name): Promise<string>` (Level-2) · `loadResource(name, path): Promise<string|Uint8Array>` (Level-3).
- REQ-5: `MemorySkillStore` + `BundledSkillStore` have zero `node:*` (Node+CF). `FsSkillStore` is backed by an RFC-02 `FileSystem` (so it works over `InMemoryFs` on Workers and Node fs alike).
- REQ-6: `SkillsCapability implements Capability` (`capabilities/index.ts:87`): `getPromptSections()` returns ONLY name+description for each skill (Level 1); `getTools()` returns `load_skill(name)` (returns the body) and `read_skill_resource(name, path)` — copying the `AutoRetrieveCapability` on-demand-tool pattern (`capabilities/AutoRetrieveCapability.ts:23-40`).
- REQ-7: Add `AgentConfig.skills?: SkillSource` (`SkillSource = Skill[] | SkillStore`). When set, the runtime registers a `SkillsCapability` into the existing capability pipeline.
- REQ-8: Scripts: a `Skill.allowedTools[]` names durable tools/flows. At wire time, each name MUST resolve to a registered `tool`/`globalTool`/flow, else fail fast. No new `scripts` field; no bash.
- REQ-9: `bun run typecheck:all` + `test` green; a `MemorySkillStore` skill loads byte-identically on Node and in a Workers test.

## 4. Interface Specification

### 4.1 `Skill` + `defineSkill` (new)
- **Location:** `packages/kuralle-skills/src/defineSkill.ts`, `types.ts`
- **Signature:** `defineSkill(s: Skill): Skill`; `interface Skill { name: string; description: string; body: string; resources?: Record<string,string|Uint8Array>; allowedTools?: string[] }`
- **Behavior:** validator pass-through; enforces frontmatter limits if constructed from markdown.

### 4.2 `parseSkillMarkdown` (new)
- **Location:** `packages/kuralle-skills/src/parseSkillMarkdown.ts`
- **Signature:** `parseSkillMarkdown(md: string, opts?: { path?: string }): Skill`
- **Behavior:** split YAML frontmatter + body; validate `name`≤64, `description`≤1024.
- **Error cases:** missing frontmatter / missing name|description / non-mapping → descriptive throw (mirror Flue messages).

### 4.3 `SkillStore` + impls (new)
- **Location:** `packages/kuralle-skills/src/stores/{memory,bundled,fs}.ts`
- **Signature:** `interface SkillStore { list(): Promise<SkillMeta[]>; loadBody(name): Promise<string>; loadResource(name, path): Promise<string|Uint8Array> }`
- **Behavior:** `MemorySkillStore(skills: Skill[])`; `BundledSkillStore(record)`; `FsSkillStore(fs: FileSystem, root: string)` (lists `*/SKILL.md`).

### 4.4 `SkillsCapability` (new)
- **Location:** `packages/kuralle-skills/src/SkillsCapability.ts`
- **Signature:** `new SkillsCapability(store: SkillStore)` implementing `Capability`.
- **Behavior:** `getPromptSections()` → one section listing skills as `name: description` (Level 1). `getTools()` → `load_skill` + `read_skill_resource` (Level 2/3), whose results flow back to the model (the `AutoRetrieveCapability` pattern).

### 4.5 `AgentConfig.skills` (modified)
- **Location:** `packages/kuralle-core/src/types/agentConfig.ts`
- **Signature:** `skills?: Skill[] | SkillStore`
- **Behavior:** presence registers a `SkillsCapability` into the capability list assembled for the agent.

## 5. Architecture and System Dependencies

### 5.1 Structural changes
New `packages/kuralle-skills/src/{defineSkill,types,parseSkillMarkdown,SkillsCapability,stores/*,index}.ts`. Modify `kuralle-core`: `agentConfig.ts` (+`skills`), the capability assembly site (where `validate`/`refine`/grounding capabilities are gathered) to add `SkillsCapability`. Reuse `Capability`/`ToolDeclaration`/`PromptSection` from core.

### 5.2 Dependencies
`@kuralle-agents/skills` depends on `@kuralle-agents/core` (Capability, defineTool types) and (type-only) the RFC-02 `FileSystem` for `FsSkillStore`. A YAML parser is needed for frontmatter — reuse whatever Flue/core uses or a tiny zero-dep front-matter split (prefer no new heavy dep; a minimal `---`-fence splitter + `yaml` if already in the tree).

### 5.3 Data/schema
None. Skills are authored as `SKILL.md` files or `defineSkill` objects.

### 5.4 Network/performance
Level-1 metadata is in the prompt (small, always). Bodies/resources load only on tool call (progressive disclosure) → minimal context cost.

## 6. Pseudocode

```
SkillsCapability(store):
  getPromptSections():
     metas = store.list()                          # name + description only (Level 1)
     return [section("Available skills", metas.map(m => `- ${m.name}: ${m.description}`))]
  getTools():
     return [
       tool("load_skill", {name}, async ({name}) => store.loadBody(name)),          # Level 2
       tool("read_skill_resource", {name, path}, async (a) => store.loadResource(a.name, a.path)) # Level 3
     ]

# wire-time validation (REQ-8)
for skill in skills:
  for t in skill.allowedTools ?? []:
    assert t in registeredTools  else throw `skill ${skill.name}: unknown tool ${t}`

# AgentConfig.skills -> capability
IF agent.skills: capabilities.push(new SkillsCapability(toStore(agent.skills)))
```

## 7. Code Blueprint

```ts
// packages/kuralle-skills/src/SkillsCapability.ts
import type { Capability, ToolDeclaration, PromptSection } from '@kuralle-agents/core';
import { z } from 'zod';
import type { SkillStore } from './stores/types.js';

export class SkillsCapability implements Capability {
  constructor(private store: SkillStore) {}

  async getPromptSections(): Promise<PromptSection[]> {
    const metas = await this.store.list();
    if (!metas.length) return [];
    const body = metas.map(m => `- ${m.name}: ${m.description}`).join('\n');
    return [{ title: 'Available skills', body: `Load a skill with load_skill when relevant:\n${body}` }];
  }

  getTools(): ToolDeclaration[] {
    return [
      { name: 'load_skill', description: 'Load a skill\'s full instructions by name.',
        parameters: z.object({ name: z.string() }),
        execute: async ({ name }: { name: string }) => ({ body: await this.store.loadBody(name) }) },
      { name: 'read_skill_resource', description: 'Read a bundled resource of a skill.',
        parameters: z.object({ name: z.string(), path: z.string() }),
        execute: async (a: { name: string; path: string }) => ({ content: await this.store.loadResource(a.name, a.path) }) },
    ];
  }
  // handleToolResult(...) null — results flow straight back (AutoRetrieveCapability pattern)
}
```

(Note: confirm the real `Capability` method names at implementation time — `getPromptSections()` and `getTools()` per `capabilities/index.ts:87-92`; the research draft mislabeled one as `getSections()`.)

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C1 | Scaffold `@kuralle-agents/skills` pkg | `packages/kuralle-skills/{package.json,tsconfig.json,src/index.ts}` | REQ-1 | builds; no `.map` shipped |
| C2 | `Skill` type + `defineSkill` + `parseSkillMarkdown` (frontmatter limits) | `src/{types,defineSkill,parseSkillMarkdown}.ts`, `test/parse.test.ts` | REQ-2,REQ-3, `test:skill-parse` | name>64 / desc>1024 / missing fields throw; valid parses |
| C3 | `SkillStore` + `MemorySkillStore` + `BundledSkillStore` (zero node:*) | `src/stores/{types,memory,bundled}.ts`, `test/stores.test.ts` | REQ-4,REQ-5, `test:skill-stores` | list/loadBody/loadResource work; `rg node: src/stores/{memory,bundled}.ts` empty |
| C4 | `FsSkillStore` over RFC-02 `FileSystem` | `src/stores/fs.ts`, `test/fs-store.test.ts` | REQ-5, `test:skill-fsstore` | lists `*/SKILL.md` from an `InMemoryFs`; loads body/resource |
| C5 | `SkillsCapability` (Level 1 prompt + load_skill/read_skill_resource tools) | `src/SkillsCapability.ts`, `test/capability.test.ts` | REQ-6, `test:skill-capability` | prompt shows only name+desc; load_skill returns body; result flows back |
| C6 | Core wiring: `AgentConfig.skills` + register capability + allowedTools validation | `kuralle-core/src/types/agentConfig.ts`, capability-assembly site | REQ-7,REQ-8, `test:skill-wire` | `defineAgent({skills})` exposes load_skill; unknown allowedTool fails fast |
| C7 | Workers parity + live example (support agent loads "returns-policy" skill, runs a "lookup_order" script tool) | `packages/kuralle-skills/test/workers.test.ts`, `examples/support-skill.ts` | REQ-9, `test:skill-workers`, `test:skill-agent` | skill loads identically on Node + workerd; script tool runs through journal |
| C8 | Docs + changeset (Skills authoring guide; Scripts = allow-listed tools) | `packages/kuralle-skills/README.md`, `docs/skills/kuralle-usage/*`, `.changeset/*` | REQ-9 | docs explain SKILL.md + progressive disclosure + Scripts |

## 9. Validation and Testing

### 9.0 Validation contract
| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..9 | §3 | as stated |
| test:skill-parse | §9.1 | frontmatter limits enforced; valid SKILL.md parses to a Skill |
| test:skill-stores | §9.1 | Memory/Bundled stores list+load; zero node:* |
| test:skill-fsstore | §9.1 | FsSkillStore over InMemoryFs lists/loads |
| test:skill-capability | §9.1 | Level-1 prompt only; load_skill returns body; read_skill_resource returns resource |
| test:skill-wire | §9.1 | AgentConfig.skills registers capability; unknown allowedTool throws at wire time |
| test:skill-agent | §9.1 | end-to-end: agent loads a skill on demand and runs an allow-listed script tool (journaled) |
| test:skill-workers | §9.1 | MemorySkillStore skill loads byte-identically in workerd |
| cmd:gate | §9.3 | `bun run typecheck:all && bun run test` green |

### 9.1 Fail-to-pass tests
- As listed above (C2–C7).

### 9.2 Regression
- `packages/kuralle-core/test/**` (capability pipeline unaffected for agents without `skills`); RFC-01/02 suites stay green.

### 9.3 Validation commands
```bash
bun run build && bun run typecheck:all && bun run test
bun packages/kuralle-skills/examples/support-skill.ts   # live: load skill on demand, run script tool
```

## 10. Security Considerations
Skills are author-provided content injected as instructions — treat `loadBody` output as trusted-author text, not user input (document: do not load skills from untrusted sources without review). Scripts cannot escalate: they are allow-listed durable tools subject to the RFC-01 enforcer/approval gates. `read_skill_resource` is confined to the skill's own resources (no path traversal across skills).

## 11. Rollback and Abort Criteria
- Abort if: the `Capability` assembly site cannot accept an async `getPromptSections()` (if the real signature is sync) — adapt the capability to the real contract; do not fork the pipeline.
- Abort if: `allowedTools` validation can't see the registered tool set at wire time — escalate the wiring order; do not skip validation (silent unknown-tool = runtime failure).
- Rollback: package is additive; remove the `skills` field + capability registration to revert.

## 12. Open Questions
- Q1: `getPromptSections()` async vs sync? — tradeoff: async lets `store.list()` be remote; sync matches current capability calls. **Proposal:** verify the real signature (`capabilities/index.ts:91`); if sync, pre-load `list()` at capability construction so `getPromptSections()` stays sync. Confirm before C5.
- Q2: YAML dependency for frontmatter? — tradeoff: new dep vs hand-rolled splitter. **Proposal:** reuse an in-tree YAML parser if one exists; else a minimal `---` fence splitter + key:value parse (frontmatter is `name`/`description` only). No heavy new dep.
- Q3: Should Scripts ever allow inline shell (just-bash over the workspace) instead of only named tools? — tradeoff: power vs the "tools return data only / Workers-portable" rule. **Proposal:** No for this RFC. Scripts = allow-listed durable tools/flows. Inline bash is a future Node-only RFC (the deferred `Shell` seam).
