import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import { packageSkillsDirectory } from '@kuralle-agents/build';
import { createArtifactTools, createAssetTools, createBrandContextTools } from '../lib/index.js';
import type { MarketingToolsDeps } from '../lib/index.js';

const INSTRUCTIONS = readFileSync(join(import.meta.dir, 'instructions.md'), 'utf8');
const SKILLS_DIR = join(import.meta.dir, 'skills');

export interface ProductMarketerAgentDeps extends MarketingToolsDeps {
  model: LanguageModel;
}

/**
 * The only specialist that can write the shared brand context — the other four get a policy
 * (see their agent.ts files) denying `save_brand_context` outright, so this is the sole path.
 */
export async function createProductMarketerAgent(deps: ProductMarketerAgentDeps): Promise<AgentConfig> {
  const { get_brand_context, save_brand_context } = createBrandContextTools(deps);
  const { save_artifact, read_artifact } = createArtifactTools(deps);
  const { upload_asset, download_asset, list_assets, get_asset_info } = createAssetTools(deps);
  const skills = await packageSkillsDirectory(SKILLS_DIR);

  return defineAgent({
    id: 'product-marketer',
    name: 'Product Marketer',
    description:
      'Works out what the product is, who it is for, and why someone would choose it: positioning, differentiation, messaging, and competitive research. Owns the shared brand context.',
    model: deps.model,
    instructions: INSTRUCTIONS,
    tools: {
      get_brand_context,
      save_brand_context,
      save_artifact,
      read_artifact,
      upload_asset,
      download_asset,
      list_assets,
      get_asset_info,
    },
    skills,
  });
}
