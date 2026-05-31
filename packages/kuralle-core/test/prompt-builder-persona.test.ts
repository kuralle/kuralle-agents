import { describe, expect, it } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';

import { BuiltinPersonas } from '../src/persona/index.ts';
import { PromptBuilder } from '../src/prompts/PromptBuilder.ts';

describe('PromptBuilder persona section', () => {
  it('renders Persona after role and before tools', () => {
    const prompt = new PromptBuilder()
      .withAgentDefinition({
        identity: 'Support Agent',
        role: 'Help customers resolve account issues.',
      })
      .addPersona(BuiltinPersonas.warm)
      .withTools({
        lookup_account: tool({
          description: 'Looks up an account.',
          inputSchema: z.object({ accountId: z.string() }),
          execute: async () => ({ found: true }),
        }),
      })
      .build();

    const roleIndex = prompt.indexOf('# Role');
    const personaIndex = prompt.indexOf('## Persona: warm');
    const toolsIndex = prompt.indexOf('# Tools');

    expect(roleIndex).toBeGreaterThan(-1);
    expect(personaIndex).toBeGreaterThan(roleIndex);
    expect(toolsIndex).toBeGreaterThan(personaIndex);
  });

  it('does not render a Persona section when no persona is set', () => {
    const prompt = new PromptBuilder()
      .withAgentDefinition({
        identity: 'Support Agent',
        role: 'Help customers resolve account issues.',
      })
      .build();

    expect(prompt).not.toContain('Persona:');
  });
});
