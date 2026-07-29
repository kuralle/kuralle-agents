import { resolve } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRuntime, type SessionStore } from '@kuralle-agents/core';
import { NodeFileSystem } from '@kuralle-agents/fs/node';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { buildPharmacyAgent } from '../src/agent.js';

export interface NodePharmacyRuntimeOptions {
  apiKey?: string;
  modelId?: string;
  /** Caller-owned durable directory. Never point this at a broad project or home root. */
  workspaceDirectory?: string;
  sessionStore?: SessionStore;
}

/**
 * Direct Node host for long-lived servers and local development. Vercel's demo
 * route intentionally fronts the Cloudflare DO because a serverless function's
 * local disk is not a durable session store; a Node deployment can instead pass
 * its Postgres session store and a durable filesystem provider here.
 */
export function createNodePharmacyRuntime(options: NodePharmacyRuntimeOptions = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for the direct Node runtime.');
  const modelId = options.modelId || process.env.MODEL_ID || 'gpt-4.1-mini';
  const model = createOpenAI({ apiKey })(modelId);
  const notes = new NodeFileSystem(resolve(options.workspaceDirectory || 'runs/pharmacy-workspace'));
  const agent = buildPharmacyAgent({ model, notesFileSystem: notes });

  const models = createModels();
  models.setProvider(openaiProvider());
  const piModel = models.getModel('openai', modelId);
  if (!piModel) throw new Error(`Pi model openai:${modelId} is not registered.`);

  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: model,
    driver: new PiDriver({ model: piModel, models, getApiKey: () => apiKey, maxSteps: 18 }),
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
  });
}
