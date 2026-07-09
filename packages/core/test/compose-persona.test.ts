import { describe, expect, it } from 'bun:test';

import { BuiltinPersonas, composePersonaPrompt } from '../src/persona/index.ts';
import { estimateTokenCount } from '../src/runtime/ContextBudget.ts';
import type { PersonaConfig } from '../src/persona/index.ts';

describe('composePersonaPrompt', () => {
  it('renders all PersonaConfig fields to the expected sections', () => {
    const persona: PersonaConfig = {
      name: 'warm',
      voice: 'warm',
      register: 'first-person-singular',
      languagePolicy: { mode: 'match-user' },
      preferredPhrases: ['happy to help', "let's figure this out together"],
      prohibitedPhrases: ['no worries', 'no problem'],
      signOff: 'Thanks!',
      customInstructions: 'Keep the customer reassured without overexplaining.',
    };

    expect(composePersonaPrompt(persona)).toBe(`## Persona: warm

Voice: warm. Register: first-person-singular.
Language: match the user's language.

Use phrases like: "happy to help", "let's figure this out together".

Avoid phrases like: "no worries", "no problem".

Sign off with: "Thanks!".

Keep the customer reassured without overexplaining.`);
  });

  it('omitted optional fields produce no extra lines', () => {
    expect(composePersonaPrompt({ name: 'custom', voice: 'clinical' })).toBe(`## Persona: custom

Voice: clinical.`);
  });

  it('renders language policy variants', () => {
    expect(composePersonaPrompt({
      name: 'english',
      voice: 'formal',
      languagePolicy: { mode: 'always-english' },
    })).toContain('Language: always reply in English.');

    expect(composePersonaPrompt({
      name: 'spanish',
      voice: 'formal',
      languagePolicy: { mode: 'specific', language: 'Spanish' },
    })).toContain('Language: always reply in Spanish.');
  });

  it('ships formal, warm, and brief built-in personas', () => {
    expect(BuiltinPersonas.formal.name).toBe('formal');
    expect(BuiltinPersonas.warm.name).toBe('warm');
    expect(BuiltinPersonas.brief.name).toBe('brief');
  });

  it('caps custom persona output at 500 tokens without throwing', () => {
    const prompt = composePersonaPrompt({
      name: 'long',
      voice: 'warm',
      customInstructions: 'Use this style. '.repeat(1000),
    });

    expect(estimateTokenCount(prompt)).toBeLessThanOrEqual(510);
    expect(prompt).toContain('[Persona truncated to 500 tokens.]');
  });
});
