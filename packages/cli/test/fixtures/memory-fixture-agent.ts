import { z } from 'zod';
import {
  createRuntime,
  defineAgent,
  defineExtractor,
  InMemoryExtractedValueStore,
  MemoryStore,
  type SessionEventLog,
  type SessionStore,
  type TraceStore,
} from '@kuralle-agents/core';
import { mockV3ReplyModel } from '../../../core/test/helpers/mockLanguageModelV3Results.js';
import type { BuildRuntime } from '../../src/agentRuntime.js';

export const tasteExtractor = defineExtractor({
  name: 'Taste',
  scope: 'user',
  instructions: 'Foods this person likes.',
  schema: z.object({ foods: z.array(z.string()) }),
});

export const agent = defineAgent({
  id: 'memory-fixture',
  instructions: 'Remember taste.',
  model: mockV3ReplyModel('OK'),
  memory: {
    extract: [tasteExtractor],
  },
});

export const extractedValueStore = new InMemoryExtractedValueStore();

export const buildRuntime: BuildRuntime = (
  sessionId = 'memory-fixture',
  store?: SessionStore,
  traceStore?: TraceStore,
  eventLog?: SessionEventLog,
) => {
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: store ?? new MemoryStore(),
    defaultModel: agent.model,
    extractedValueStore,
    eventLog,
    tracing: traceStore ? { store: traceStore } : undefined,
  });
  return {
    runtime,
    store: store ?? new MemoryStore(),
    sessionId,
    agentId: agent.id,
    label: 'memory fixture',
    readState: async () => ({ roles: [] }),
  };
};
