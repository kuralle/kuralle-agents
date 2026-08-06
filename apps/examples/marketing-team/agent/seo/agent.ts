import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { defineAgent, readOnlyPolicy, type AgentConfig } from '@kuralle-agents/core';
import { AGENT_LIMITS } from '../limits.js';
import { packageSkillsDirectory } from '@kuralle-agents/build';
import { createArtifactTools, createAssetTools, createBrandContextTools } from '../lib/index.js';
import type { MarketingToolsDeps } from '../lib/index.js';

const INSTRUCTIONS = readFileSync(join(import.meta.dir, 'instructions.md'), 'utf8');
const SKILLS_DIR = join(import.meta.dir, 'skills');

export interface SeoAgentDeps extends MarketingToolsDeps {
  model: LanguageModel;
}

/**
 * Diagnoses and plans organic search work. Only reads the brand context, never writes it —
 * `save_brand_context` is denied by policy at the tool boundary (b5 action item 5).
 */
export async function createSeoAgent(deps: SeoAgentDeps): Promise<AgentConfig> {
  const { get_brand_context } = createBrandContextTools(deps);
  const { save_artifact, read_artifact } = createArtifactTools(deps);
  const { upload_asset, download_asset, list_assets, get_asset_info } = createAssetTools(deps);
  const skills = await packageSkillsDirectory(SKILLS_DIR);

  return defineAgent({
    id: 'seo',
    name: 'SEO',
    description:
      'Diagnoses and plans organic search work: page and site audits, site architecture, structured data, and programmatic SEO.',
    model: deps.model,
    limits: AGENT_LIMITS,
    instructions: INSTRUCTIONS,
    tools: {
      get_brand_context,
      save_artifact,
      read_artifact,
      upload_asset,
      download_asset,
      list_assets,
      get_asset_info,
    },
    policy: readOnlyPolicy(['save_brand_context']),
    skills,
  });
}
