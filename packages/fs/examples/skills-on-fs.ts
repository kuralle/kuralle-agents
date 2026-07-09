#!/usr/bin/env bun
/**
 * Deterministic (no model) demo: skills living on a workspace filesystem as
 * SKILL.md folders, disclosed to an agent through fsSkillStore. Proves the
 * progressive-disclosure plumbing without an API key.
 *
 * Run:  bun run packages/fs/examples/skills-on-fs.ts
 */
import { defineAgent } from '@kuralle-agents/core';
import { InMemoryFs, fsSkillStore } from '@kuralle-agents/fs';

const REFUNDS_SKILL = `---
name: refunds
description: Handle refund requests within the 30-day policy window.
---

# Refunds
1. Verify the order date is within 30 days.
2. Issue the refund via the payments tool.
`;

async function main() {
  // Skills live on the workspace fs as SKILL.md folders (+ a reference file).
  const fs = new InMemoryFs({
    '/skills/refunds/SKILL.md': REFUNDS_SKILL,
    '/skills/refunds/references/policy.md': '# Refund policy\n30-day window applies.',
  });

  const store = fsSkillStore(fs);

  // The store implements SkillStoreLike, so it drops straight into an agent.
  const agent = defineAgent({
    id: 'support',
    instructions: 'Answer support questions. Load a skill when it fits the task.',
    workspace: fs,
    skills: store,
  });
  void agent;

  // Progressive disclosure: metadata is listed; bodies load on demand.
  console.log('list():', JSON.stringify(await store.list(), null, 2));
  console.log('loadBody("refunds"):\n' + (await store.loadBody('refunds')));
  console.log(
    'loadResource("refunds","references/policy.md"):',
    await store.loadResource('refunds', 'references/policy.md'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
