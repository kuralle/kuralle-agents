import type { BrandVoiceConfig } from './types.js';

export interface BrandVoiceTemplate {
  tone: string;
  styleRules: string[];
  avoidPhrases: string[];
  emojiPolicy: 'never' | 'minimal' | 'moderate' | 'encouraged';
}

export const BRAND_VOICE_TEMPLATES: Record<Exclude<BrandVoiceConfig['tone'], 'custom' | undefined>, BrandVoiceTemplate> = {
  formal: {
    tone: 'Professional and respectful. Use complete sentences and proper grammar.',
    styleRules: [
      'Address customers formally (use "you" respectfully)',
      'Avoid contractions in serious contexts',
      'Be precise and factual',
    ],
    avoidPhrases: ['No problem', 'Cool', 'Awesome', 'Yeah', 'Hey'],
    emojiPolicy: 'never',
  },
  casual: {
    tone: 'Friendly and conversational. Natural, human-like communication.',
    styleRules: [
      'Use contractions freely',
      'Keep it light and approachable',
      'Match customer energy level',
    ],
    avoidPhrases: ['Pursuant to', 'Please be advised', 'Kindly', 'At your earliest convenience'],
    emojiPolicy: 'moderate',
  },
  friendly: {
    tone: 'Warm and helpful. Balance professionalism with approachability.',
    styleRules: [
      'Be personable but not overly casual',
      'Show empathy in responses',
      'Use natural conversational language',
    ],
    avoidPhrases: ['As per our policy', 'Unfortunately', 'We regret to inform'],
    emojiPolicy: 'minimal',
  },
  professional: {
    tone: 'Competent and reliable. Clear, efficient communication.',
    styleRules: [
      'Be direct and solution-focused',
      'Avoid unnecessary flourishes',
      'Maintain professional boundaries',
    ],
    avoidPhrases: ['LOL', 'OMG', 'TBH', 'fr', 'omg'],
    emojiPolicy: 'never',
  },
};

export function buildBrandVoiceSection(config: BrandVoiceConfig): string {
  const template = config.tone && config.tone !== 'custom' ? BRAND_VOICE_TEMPLATES[config.tone] : null;

  const parts: string[] = [];

  // Tone
  const tone = config.toneCustom ?? template?.tone ?? config.tone ?? 'Professional and helpful';
  parts.push(`**Tone:** ${tone}`);

  // Personality
  if (config.personality) {
    parts.push(`**Personality:** ${config.personality}`);
  }

  // Style rules
  const styleRules = config.styleRules ?? template?.styleRules ?? [];
  if (styleRules.length > 0) {
    parts.push(`**Style Guidelines:**\n${styleRules.map(r => `- ${r}`).join('\n')}`);
  }

  // Avoid phrases
  const avoidPhrases = config.avoidPhrases ?? template?.avoidPhrases ?? [];
  if (avoidPhrases.length > 0) {
    parts.push(`**Avoid saying:** ${avoidPhrases.join(', ')}`);
  }

  // Preferred phrases
  if (config.preferredPhrases?.length) {
    parts.push(`**Preferred phrases:** ${config.preferredPhrases.join(', ')}`);
  }

  // Emoji policy
  const emojiPolicy = config.emojiPolicy ?? template?.emojiPolicy ?? 'never';
  const emojiGuidance: Record<typeof emojiPolicy, string> = {
    never: 'Do not use emojis.',
    minimal: 'Use emojis sparingly, only when appropriate (e.g., simple smiley).',
    moderate: 'Emojis are acceptable to convey tone and warmth.',
    encouraged: 'Use emojis freely to enhance friendly communication.',
  };
  parts.push(`**Emoji usage:** ${emojiGuidance[emojiPolicy]}`);

  // Response length
  if (config.responseLength) {
    const lengthGuidance: Record<typeof config.responseLength, string> = {
      brief: 'Keep responses short and to the point. One to two sentences when possible.',
      moderate: 'Balance brevity with completeness. Include necessary details but avoid verbosity.',
      detailed: 'Provide thorough, comprehensive responses. Cover all relevant aspects.',
    };
    parts.push(`**Response length:** ${lengthGuidance[config.responseLength]}`);
  }

  return parts.join('\n\n');
}
