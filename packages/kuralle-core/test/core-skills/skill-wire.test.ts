import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent, defineTool } from '@kuralle-agents/core';
import { defineSkill, wireAgentSkills } from '@kuralle-agents/skills';

describe('test:skill-wire', () => {
  const lookupOrder = defineTool({
    name: 'lookup_order',
    description: 'Fetch order status.',
    input: z.object({ orderId: z.string() }),
    execute: async () => ({ ok: true }),
  });

  const returnsPolicy = defineSkill({
    name: 'returns-policy',
    description: 'Return policy.',
    body: 'Policy body',
    allowedTools: ['lookup_order'],
  });

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
  });

  it('unknown allowedTool fails fast at wire time', async () => {
    const badSkill = defineSkill({
      name: 'bad-skill',
      description: 'Bad skill.',
      body: 'body',
      allowedTools: ['missing_tool'],
    });

    const agent = defineAgent({
      id: 'support',
      instructions: 'Support',
      tools: { lookup_order: lookupOrder },
      skills: [badSkill],
    });

    await expect(wireAgentSkills(agent)).rejects.toThrow('skill bad-skill: unknown tool missing_tool');
  });
});
