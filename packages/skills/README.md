# @kuralle-agents/skills

Anthropic-style Agent Skills for Kuralle — `SKILL.md` folders with **3-level progressive disclosure**:

1. **Level 1 (always):** `name` + `description` in the system prompt
2. **Level 2 (on demand):** full `SKILL.md` body via `load_skill`
3. **Level 3 (on read):** bundled resources via `read_skill_resource`

**Scripts** are not bash. A skill references pre-registered durable tools or flows by name via `allowedTools` (validated at wire time).

## Quick start

```ts
import { createRuntime, defineAgent, defineTool } from '@kuralle-agents/core';
import { defineSkill } from '@kuralle-agents/skills';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Fetch order status.',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.get(orderId),
});

const returnsPolicy = defineSkill({
  name: 'returns-policy',
  description: 'Return policy guidance. Use when the customer asks about returns.',
  allowedTools: ['lookup_order'],
  body: '1. Run lookup_order with the order id.\n2. Apply the 30-day window.',
  resources: { 'exceptions.md': '# Gift cards are non-returnable' },
});

const agent = defineAgent({
  id: 'support',
  model,
  instructions: 'Calm support agent.',
  tools: { lookup_order: lookupOrder },
  skills: [returnsPolicy],
});
```

Set `AgentConfig.skills` to inline `defineSkill` objects, a `Skill[]`, or a `SkillStore` (`MemorySkillStore`, `BundledSkillStore`, `FsSkillStore`).

## SKILL.md authoring

```markdown
---
name: returns-policy
description: Explains the 30-day return window for customer inquiries.
allowed-tools: lookup_order
---

# Returns policy
Confirm the order id, then run `lookup_order`.
```

Frontmatter limits (Agent Skills spec): `name` ≤ 64 chars, `description` ≤ 1024 chars.

Parse files with `parseSkillMarkdown(md, { path, directoryName })`.

## Stores

| Store | Runtime | Notes |
|-------|---------|-------|
| `MemorySkillStore` | Node + Workers | Default; inline `defineSkill` objects |
| `BundledSkillStore` | Node + Workers | `Record<name, Skill>` manifest |
| `FsSkillStore` | Any `FileSystem` | Lists `*/SKILL.md` under a root (uses `@kuralle-agents/fs` / `AgentConfig.workspace` backend) |

## Multi-turn & reloading

A `load_skill` result stays in the conversation transcript (restored each turn), so a loaded skill is
**reused across turns without reloading** — a follow-up about an already-loaded skill is answered from
context. `load_skill` is model-driven with **no framework-level dedup**: each call re-fetches the body,
and the model decides whether to reload. Nudge reuse in the agent instructions
(*"reuse a skill already loaded earlier"*); a redundant reload only costs tokens, never correctness.
An agent can also load **multiple skills in a single turn**.

## Live smokes

```bash
KURALLE_EXAMPLE_PROVIDER=openai bun packages/skills/examples/support-skill.ts        # one skill, one turn
KURALLE_EXAMPLE_PROVIDER=openai bun packages/skills/examples/multi-turn-skills.ts    # 5 skills, multi-turn selection
KURALLE_EXAMPLE_PROVIDER=openai bun packages/skills/examples/skill-history-inspect.ts # proves cross-turn reuse
```

## Security

Treat skill bodies as **trusted author content**. Do not load skills from untrusted sources without review. `read_skill_resource` is confined to each skill's own resources (no cross-skill path traversal).
