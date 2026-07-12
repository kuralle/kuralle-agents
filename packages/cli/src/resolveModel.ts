import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { AgentConfig } from '@kuralle-agents/core';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '../.env') });
config({ path: join(here, '../../../.env') });

/** Resolve a speaker model for a bare agent: agent.model → --model → OPENAI_MODEL → error. */
export function resolveCliModel(agent: AgentConfig, modelFlag?: string): LanguageModel {
  if (agent.model) return agent.model;

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('No OPENAI_API_KEY — set it in packages/cli/.env or the repo .env');
    process.exit(2);
  }
  const openai = createOpenAI({ apiKey: key });
  if (modelFlag) return openai(modelFlag);
  if (process.env.OPENAI_MODEL) return openai(process.env.OPENAI_MODEL);

  console.error('agent has no model; pass --model');
  process.exit(2);
}