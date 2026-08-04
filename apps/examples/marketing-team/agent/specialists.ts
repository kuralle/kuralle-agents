import type { LanguageModel } from 'ai';
import type { AgentConfig } from '@kuralle-agents/core';
import { createContentMarketerAgent } from './content-marketer/agent.js';
import { createEmailAgent } from './email/agent.js';
import { createProductMarketerAgent } from './product-marketer/agent.js';
import { createSeoAgent } from './seo/agent.js';
import { createSocialMediaCoordinatorAgent } from './social-media-coordinator/agent.js';
import type { MarketingToolsDeps } from './lib/index.js';

/** Every specialist id the lead's `routes` can target, in the order `createSpecialistAgents` builds them. */
export const SPECIALIST_IDS = [
  'product-marketer',
  'content-marketer',
  'email',
  'seo',
  'social-media-coordinator',
] as const;

export type SpecialistId = (typeof SPECIALIST_IDS)[number];

export interface SpecialistAgentDeps extends MarketingToolsDeps {
  model: LanguageModel;
}

/** Builds all five specialists from the same deps, one call per id in `SPECIALIST_IDS`. */
export async function createSpecialistAgents(deps: SpecialistAgentDeps): Promise<AgentConfig[]> {
  return Promise.all([
    createProductMarketerAgent(deps),
    createContentMarketerAgent(deps),
    createEmailAgent(deps),
    createSeoAgent(deps),
    createSocialMediaCoordinatorAgent(deps),
  ]);
}
