import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { defineAgent, readOnlyPolicy, type AgentConfig } from '@kuralle-agents/core';
import { AGENT_LIMITS } from '../limits.js';
import { packageSkillsDirectory } from '@kuralle-agents/build';
import { createArtifactTools, createBrandContextTools, createContentTools, createLintTools, createTrackingTools } from '../lib/index.js';
import type { MarketingToolsDeps } from '../lib/index.js';

const INSTRUCTIONS = readFileSync(join(import.meta.dir, 'instructions.md'), 'utf8');
const SKILLS_DIR = join(import.meta.dir, 'skills');
const SHARED_SKILLS_DIR = join(import.meta.dir, '../shared/skills');

export interface EmailAgentDeps extends MarketingToolsDeps {
  model: LanguageModel;
}

/**
 * Adapts copy for the inbox and operates the email channel. Only reads the brand context, never
 * writes it — `save_brand_context` is denied by policy at the tool boundary (b5 action item 5).
 */
export async function createEmailAgent(deps: EmailAgentDeps): Promise<AgentConfig> {
  const { get_brand_context } = createBrandContextTools(deps);
  const { read_artifact, save_artifact } = createArtifactTools(deps);
  const { create_content, update_content, get_content, list_content, set_content_status } =
    createContentTools(deps);
  const { lint_against_style } = createLintTools(deps);
  const { build_tracked_link } = createTrackingTools(deps);
  const [ownSkills, sharedSkills] = await Promise.all([
    packageSkillsDirectory(SKILLS_DIR),
    packageSkillsDirectory(SHARED_SKILLS_DIR),
  ]);

  return defineAgent({
    id: 'email',
    name: 'Email',
    description:
      'Adapts existing copy for the inbox — subject, preview text, one call to action, plain text — and operates the email channel.',
    model: deps.model,
    limits: AGENT_LIMITS,
    instructions: INSTRUCTIONS,
    tools: {
      get_brand_context,
      read_artifact,
      save_artifact,
      create_content,
      update_content,
      get_content,
      list_content,
      set_content_status,
      lint_against_style,
      build_tracked_link,
    },
    policy: readOnlyPolicy(['save_brand_context']),
    skills: [ownSkills, sharedSkills],
  });
}
