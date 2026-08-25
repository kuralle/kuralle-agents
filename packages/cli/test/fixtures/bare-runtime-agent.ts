import { createRuntime, defineAgent, MemoryStore } from '@kuralle-agents/core';
import { mockV3ReplyModel } from '../../../core/test/helpers/mockLanguageModelV3Results.js';

const agent = defineAgent({
  id: 'bare-runtime',
  instructions: 'Reply with the single word ready.',
  model: mockV3ReplyModel('ready'),
});

export const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: agent.model,
  sessionStore: new MemoryStore(),
});

export default runtime;
