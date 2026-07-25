---
'@kuralle-agents/core': major
'@kuralle-agents/fs': major
---

Consolidate skills into `@kuralle-agents/core` and widen `AgentConfig.skills`.

**Removed `@kuralle-agents/skills`.** Its `types.ts` was a rename re-export of core's types (`SkillLike as Skill`, `SkillStoreLike as SkillStore`), and it re-implemented core's `collectSkills`/`isSkillStore`/`prepareSkillStore`. Migration is one import line: `defineSkill` now comes from `@kuralle-agents/core`. `Skill` → `SkillLike`, `SkillStore` → `SkillStoreLike`.

**`@kuralle-agents/fs` no longer exports `defineSkill`, `fsSkillStore`, or `parseSkillFrontmatter`** — all three moved to core. They only ever consumed the `FileSystem` interface, which core already owns, so nothing platform-specific moved. `fs` keeps what genuinely needs a platform: the filesystem implementations, shell, and SQL/R2 backends.

Between the two competing implementations, core keeps `fs`'s: its parser handles BOM and CRLF, supports `license`/`compatibility`/`metadata`, and measures description length in code points; its store layers **ordered roots** where the other was single-root.

**`AgentConfig.skills` now accepts paths and mixed arrays.** Previously a `SkillLike`, `SkillLike[]`, or a store you had to construct. Now also a workspace path string, and any mix of the three, with **later entries winning** a name collision:

```ts
skills: ['/skills/org', '/skills/team', defineSkill({ name: 'refunds', … })]
```

Paths resolve against the agent's `workspace` filesystem; using one without a workspace throws and names the fix. Mixed sources compose through a new `CompositeSkillStore` that delegates rather than flattening, so progressive disclosure is preserved — only Level 1 metadata is eager.

**Stricter `SKILL.md` validation**, matching the Agent Skills spec: names and descriptions may no longer contain XML tags, and names may not contain the reserved words `anthropic` or `claude`. Both fields are injected into the system prompt, so markup there is a prompt-injection seam.
