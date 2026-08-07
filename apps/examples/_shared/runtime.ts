import { createOpenAI } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  createRuntime,
  type AgentConfig,
  type KnowledgeProviderConfig,
  type SessionStore,
  type TraceStore,
} from '@kuralle-agents/core';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { config as loadEnv } from 'dotenv';
import type { LanguageModel } from 'ai';
import { resolve } from 'node:path';

const workingDirectory = process.cwd();
loadEnv({ path: resolve(workingDirectory, '.env'), quiet: true });
loadEnv({ path: resolve(workingDirectory, '../../..', '.env'), quiet: true });

export interface ProductionRuntimeOptions {
  buildAgent: (model: LanguageModel) => AgentConfig;
  sessionStore?: SessionStore;
  traceStore?: TraceStore;
  knowledge?: KnowledgeProviderConfig;
}

export function createProductionRuntime(options: ProductionRuntimeOptions) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required. Add it to the repository root .env file.');
  }

  const modelId = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini';
  const aiSdkModel = createOpenAI({ apiKey })(modelId);
  const agent = options.buildAgent(aiSdkModel);
  const selectedDriver = process.env.KURALLE_DRIVER?.trim() || 'pi';
  if (selectedDriver !== 'pi' && selectedDriver !== 'ai-sdk') {
    throw new Error(`KURALLE_DRIVER must be "pi" or "ai-sdk", received "${selectedDriver}".`);
  }

  let driver;
  if (selectedDriver === 'pi') {
    const models = createModels();
    models.setProvider(openaiProvider());
    const piModel = models.getModel('openai', modelId);
    if (!piModel) throw new Error(`Pi did not register openai:${modelId}.`);
    driver = new PiDriver({
      model: piModel,
      models,
      getApiKey: () => apiKey,
      maxSteps: 20,
    });
  }

  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: aiSdkModel,
    ...(driver ? { driver } : {}),
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.traceStore ? { tracing: { store: options.traceStore } } : {}),
    ...(options.knowledge ? { knowledge: options.knowledge } : {}),
  });
}
