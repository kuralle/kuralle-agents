import { describe, expect, it } from 'bun:test';
import type { Session } from '@kuralle-agents/core';
import { buildAgentToolSurface } from '../../core/dist/runtime/buildAgentToolSurface.js';
import { fsSkillStore, InMemoryFs } from '../src/index.js';

function makeTestSession(sessionId = 'sess-1'): Session {
  const now = new Date();
  return {
    id: sessionId,
    conversationId: sessionId,
    channelId: 'api',
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-1',
    agentStates: {},
    handoffHistory: [],
  };
}

describe('test:fs-skills-integration', () => {
  const refundsSkill = `---
name: refunds
description: Handle refund requests and policy lookups.
---

# Refunds skill body
Process refunds per policy.
`;

  const ordersSkill = `---
name: orders
description: Look up and manage customer orders.
---

# Orders skill body
Track order status.
`;

  const policyResource = '# Refund policy\n30-day window applies.';

  it('buildAgentToolSurface discloses fsSkillStore skills and tools execute', async () => {
    const fs = new InMemoryFs({
      '/skills/refunds/SKILL.md': refundsSkill,
      '/skills/orders/SKILL.md': ordersSkill,
      '/skills/refunds/references/policy.md': policyResource,
    });

    const agent = {
      id: 'support',
      instructions: 'Support agent',
      workspace: fs,
      skills: fsSkillStore(fs),
    };

    const surface = await buildAgentToolSurface(agent, makeTestSession(), {});

    expect(surface.globalTools.load_skill?.name).toBe('load_skill');
    expect(surface.globalTools.read_skill_resource?.name).toBe('read_skill_resource');
    expect(surface.executorTools.load_skill?.name).toBe('load_skill');
    expect(surface.executorTools.read_skill_resource?.name).toBe('read_skill_resource');

    expect(surface.skillPrompt).toBeTruthy();
    expect(surface.skillPrompt).toContain('refunds');
    expect(surface.skillPrompt).toContain('orders');

    const loadSkill = surface.globalTools.load_skill;
    const readResource = surface.globalTools.read_skill_resource;
    if (!loadSkill?.execute || !readResource?.execute) {
      throw new Error('skill tools missing execute');
    }

    const loaded = await loadSkill.execute({ name: 'refunds' });
    expect(loaded).toMatchObject({
      body: '# Refunds skill body\nProcess refunds per policy.\n',
    });

    const resource = await readResource.execute({
      name: 'refunds',
      path: 'references/policy.md',
    });
    expect(resource).toMatchObject({ content: policyResource });
  });
});