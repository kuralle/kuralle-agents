import { createOpenAI } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import {
  createRuntime,
  type HarnessConfig,
  type SessionStore,
  type TraceStore,
} from '@kuralle-agents/core';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { supportConfig } from '../support.config';
import { buildSupportAgent } from './agent';
import type { SupportBackend } from './backend';
import { createSupportKnowledge } from './knowledge';

export interface SupportRuntimePartsOptions {
  apiKey: string;
  modelId: string;
  backend: SupportBackend;
  traceStore?: TraceStore;
}

export function buildSupportRuntimeParts(options: SupportRuntimePartsOptions) {
  const model = createOpenAI({ apiKey: options.apiKey })(options.modelId);
  const models = createModels();
  models.setProvider(openaiProvider());
  const piModel = models.getModel('openai', options.modelId);
  if (!piModel) throw new Error(`Pi did not register openai:${options.modelId}.`);
  const agent = buildSupportAgent({ model, backend: options.backend, config: supportConfig });

  const config: Omit<HarnessConfig, 'agents' | 'defaultAgentId' | 'sessionStore'> = {
    defaultModel: model,
    driver: new PiDriver({
      model: piModel,
      models,
      getApiKey: () => options.apiKey,
      maxSteps: 20,
    }),
    knowledge: createSupportKnowledge(supportConfig),
    escalation: {
      handler: (request) => options.backend.queueEscalation(request),
      model,
      summarize: true,
      recentMessageCount: 12,
    },
    compaction: {
      triggerTokens: 14_000,
      keepRecentMessages: 12,
    },
    tracing: {
      enabled: true,
      ...(options.traceStore ? { store: options.traceStore } : {}),
      sampling: 1,
    },
  };

  return { agent, config };
}

export function createSupportRuntime(options: SupportRuntimePartsOptions & { sessionStore: SessionStore }) {
  const { agent, config } = buildSupportRuntimeParts(options);
  return createRuntime({
    ...config,
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: options.sessionStore,
  });
}
