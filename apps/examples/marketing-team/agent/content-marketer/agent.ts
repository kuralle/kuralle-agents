import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { defineAgent, readOnlyPolicy, type AgentConfig } from '@kuralle-agents/core';
import { AGENT_LIMITS } from '../limits.js';
import { packageSkillsDirectory } from '@kuralle-agents/build';
import { createArtifactTools, createAssetTools, createBrandContextTools, createContentTools, createLintTools } from '../lib/index.js';
import type { MarketingToolsDeps } from '../lib/index.js';

const INSTRUCTIONS = readFileSync(join(import.meta.dir, 'instructions.md'), 'utf8');
const SKILLS_DIR = join(import.meta.dir, 'skills');
const SHARED_SKILLS_DIR = join(import.meta.dir, '../shared/skills');

export interface ContentMarketerAgentDeps extends MarketingToolsDeps {
  model: LanguageModel;
}

/**
 * Plans and writes long-form content. Only reads the brand context, never writes it — `save_brand_context`
 * is denied by policy at the tool boundary, not left to the prompt (b5 action item 5).
 */
export async function createContentMarketerAgent(deps: ContentMarketerAgentDeps): Promise<AgentConfig> {
  const { get_brand_context } = createBrandContextTools(deps);
  const { save_artifact, read_artifact } = createArtifactTools(deps);
  const { upload_asset, download_asset, list_assets, get_asset_info } = createAssetTools(deps);
  const { create_content, update_content, get_content, list_content, set_content_status } =
    createContentTools(deps);
  const { lint_against_style } = createLintTools(deps);
  const [ownSkills, sharedSkills] = await Promise.all([
    packageSkillsDirectory(SKILLS_DIR),
    packageSkillsDirectory(SHARED_SKILLS_DIR),
  ]);

  return defineAgent({
    id: 'content-marketer',
    name: 'Content Marketer',
    description:
      'Plans and writes long-form content: blog posts, landing pages, case studies, docs, and the prose for newsletters.',
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
      create_content,
      update_content,
      get_content,
      list_content,
      set_content_status,
      lint_against_style,
    },
    policy: readOnlyPolicy(['save_brand_context']),
    skills: [ownSkills, sharedSkills],
  });
}
