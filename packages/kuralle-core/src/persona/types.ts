export type PersonaVoice =
  | 'formal'
  | 'warm'
  | 'playful'
  | 'concise'
  | 'clinical'
  | (string & {});

export type PersonaRegister =
  | 'first-person-singular'
  | 'first-person-plural'
  | 'second-person-direct';

export type PersonaLanguagePolicy =
  | { mode: 'always-english' }
  | { mode: 'match-user' }
  | { mode: 'specific'; language: string };

export interface PersonaConfig {
  readonly name: string;
  readonly voice: PersonaVoice;
  readonly register?: PersonaRegister;
  readonly languagePolicy?: PersonaLanguagePolicy;
  readonly prohibitedPhrases?: string[];
  readonly preferredPhrases?: string[];
  readonly signOff?: string;
  readonly customInstructions?: string;
}

export type PersonaExperimentCohort = 'control' | 'variant';

export interface PersonaExperimentMetadata {
  cohort: PersonaExperimentCohort;
  personaName: string;
  allocatedAt: string;
}
