import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import { AGENT_LIMITS } from './limits.js';
import { createArtifactTools, createBrandContextTools, createUserPreferenceTools } from './lib/index.js';
import type { MarketingToolsDeps } from './lib/index.js';

const INSTRUCTIONS = readFileSync(join(import.meta.dir, 'instructions.md'), 'utf8');

export interface LeadAgentDeps extends MarketingToolsDeps {
  model: LanguageModel;
}

/**
 * The routing layer to the five specialists. Dispatch is silent (no "let me route this to..."
 * narration) — the framework's transfer control tool fires without announcement by default.
 *
 * Tool grant is deliberately narrow: `get_brand_context`, `read_artifact`, and the
 * user-preference tools only. No `save_artifact` (a relayed document could otherwise pass
 * through the lead's own context) and no `save_brand_context` (only product-marketer writes
 * the shared document — see agent/product-marketer/agent.ts).
 */
export function createLeadAgent(deps: LeadAgentDeps): AgentConfig {
  const { get_brand_context } = createBrandContextTools(deps);
  const { read_artifact } = createArtifactTools(deps);
  const { get_user_preferences, save_user_preferences, clear_user_preferences } =
    createUserPreferenceTools(deps);

  return defineAgent({
    id: 'lead',
    name: 'Marketing Lead',
    description:
      'Routes marketing work to the specialist who does it and hands back what they produced.',
    model: deps.model,
    limits: AGENT_LIMITS,
    instructions: INSTRUCTIONS,
    tools: {
      get_brand_context,
      read_artifact,
      get_user_preferences,
      save_user_preferences,
      clear_user_preferences,
    },
    routes: [
      {
        agent: 'product-marketer',
        when:
          'the brand context is empty or needs establishing or revising: positioning, differentiation, ideal customer, messaging, or competitive research',
      },
      {
        agent: 'content-marketer',
        when:
          'planning or writing long-form content: a blog post, landing page, case study, docs page, or the prose for a newsletter',
      },
      {
        agent: 'email',
        when:
          'adapting existing copy into an email or newsletter broadcast, or any work operating the email channel',
      },
      {
        agent: 'seo',
        when:
          'auditing a page or site for organic search, planning site structure or internal linking, writing schema markup, or planning programmatic SEO pages',
      },
      {
        agent: 'social-media-coordinator',
        when: 'drafting or managing a post for X, LinkedIn, Threads, Bluesky, or Mastodon',
      },
    ],
    routing: { model: deps.model },
  });
}
