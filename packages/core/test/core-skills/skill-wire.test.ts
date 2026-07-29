import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent, defineTool, wireAgentSkills } from '@kuralle-agents/core';
import { InMemoryFs } from '@kuralle-agents/fs';

describe('test:skill-wire', () => {
  const lookupOrder = defineTool({
    name: 'lookup_order',
    description: 'Fetch order status.',
    input: z.object({ orderId: z.string() }),
    execute: async () => ({ ok: true }),
  });

  const returnsPolicy = {
    name: 'returns-policy',
    description: 'Return policy.',
    body: 'Policy body',
    allowedTools: ['lookup_order'],
  };

  it('defineAgent({ skills }) exposes load_skill and read_skill_resource', async () => {
    const agent = defineAgent({
      id: 'support',
      instructions: 'Support',
      tools: { lookup_order: lookupOrder },
      skills: [returnsPolicy],
    });

    const wired = await wireAgentSkills(agent);
    expect(wired?.tools.load_skill?.name).toBe('load_skill');
    expect(wired?.tools.read_skill_resource?.name).toBe('read_skill_resource');
    expect(wired?.promptSections[0]?.content).toContain('returns-policy: Return policy.');
    expect(wired?.promptSections[0]?.content).not.toContain('Policy body');
    expect(wired?.promptSections[0]?.content).toContain('/knowledge or /notes');
    expect(wired?.tools.read_skill_resource?.description).toContain('Never use this for absolute workspace paths');
  });

  it('unknown allowedTool fails fast at wire time', async () => {
    const badSkill = {
      name: 'bad-skill',
      description: 'Bad skill.',
      body: 'body',
      allowedTools: ['missing_tool'],
    };

    const agent = defineAgent({
      id: 'support',
      instructions: 'Support',
      tools: { lookup_order: lookupOrder },
      skills: [badSkill],
    });

    await expect(wireAgentSkills(agent)).rejects.toThrow('skill bad-skill: unknown tool missing_tool');
  });

  it('accepts the Core-generated workspace tool in allowed-tools', async () => {
    const agent = defineAgent({
      id: 'workspace-skill',
      workspace: new InMemoryFs({ '/kb/policy.md': 'Policy' }),
      skills: [{
        name: 'policy-review',
        description: 'Review policy files.',
        body: 'Use the workspace tool to inspect the policy.',
        allowedTools: ['workspace'],
      }],
    });

    await expect(wireAgentSkills(agent, agent.workspace as InMemoryFs)).resolves.toBeDefined();
  });
});
