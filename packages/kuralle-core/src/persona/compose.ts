import type { PersonaConfig, PersonaLanguagePolicy } from './types.js';

const MAX_PERSONA_TOKENS = 500;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_PERSONA_CHARS = MAX_PERSONA_TOKENS * APPROX_CHARS_PER_TOKEN;

export function composePersonaPrompt(persona: PersonaConfig): string {
  const lines: string[] = [`## Persona: ${persona.name}`, ''];
  lines.push(`Voice: ${persona.voice}.${persona.register ? ` Register: ${persona.register}.` : ''}`);

  if (persona.languagePolicy) {
    lines.push(`Language: ${formatLanguagePolicy(persona.languagePolicy)}`);
  }

  if (persona.preferredPhrases?.length) {
    lines.push('', `Use phrases like: ${formatPhrases(persona.preferredPhrases)}.`);
  }

  if (persona.prohibitedPhrases?.length) {
    lines.push('', `Avoid phrases like: ${formatPhrases(persona.prohibitedPhrases)}.`);
  }

  if (persona.signOff) {
    lines.push('', `Sign off with: "${persona.signOff}".`);
  }

  if (persona.customInstructions) {
    lines.push('', persona.customInstructions);
  }

  return capPersonaPrompt(lines.join('\n'));
}

function formatLanguagePolicy(policy: PersonaLanguagePolicy): string {
  switch (policy.mode) {
    case 'always-english':
      return 'always reply in English.';
    case 'match-user':
      return "match the user's language.";
    case 'specific':
      return `always reply in ${policy.language}.`;
  }
}

function formatPhrases(phrases: string[]): string {
  return phrases.map((phrase) => `"${phrase}"`).join(', ');
}

function capPersonaPrompt(prompt: string): string {
  if (prompt.length <= MAX_PERSONA_CHARS) {
    return prompt;
  }

  return `${prompt.slice(0, MAX_PERSONA_CHARS).trimEnd()}\n\n[Persona truncated to ${MAX_PERSONA_TOKENS} tokens.]`;
}
