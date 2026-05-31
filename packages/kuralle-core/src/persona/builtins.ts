import type { PersonaConfig } from './types.js';

export const BuiltinPersonas: {
  formal: PersonaConfig;
  warm: PersonaConfig;
  brief: PersonaConfig;
} = {
  formal: {
    name: 'formal',
    voice: 'formal',
    register: 'first-person-plural',
    languagePolicy: { mode: 'match-user' },
    prohibitedPhrases: ['no worries', 'no problem', 'super easy'],
    signOff: 'Best regards',
  },
  warm: {
    name: 'warm',
    voice: 'warm',
    register: 'first-person-singular',
    languagePolicy: { mode: 'match-user' },
    preferredPhrases: ['happy to help', "let's figure this out together"],
    signOff: 'Thanks!',
  },
  brief: {
    name: 'brief',
    voice: 'concise',
    register: 'second-person-direct',
    prohibitedPhrases: ['I would be happy to', 'Of course!', 'Certainly!'],
    customInstructions: 'Reply in 1-3 sentences. No preambles. No sign-off.',
  },
};
