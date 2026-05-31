import { config } from 'dotenv';
config();

import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { runPlaygroundConversation } from '../_shared/runtime/smokeRunner.js';
import { buildAgents } from './src/agents.js';
import { knowledgeConfig } from './src/knowledge.js';

loadPlaygroundEnv(import.meta.url);
const { model, label } = resolvePlaygroundModel();

runPlaygroundConversation({
  title: `acme-support-agent live smoke (${label})`,
  agents: buildAgents(model),
  defaultAgentId: 'triage',
  model,
  knowledge: knowledgeConfig,
  prompts: [
    'Can I return the Widget X100 and how long will the refund take?',
    'Compare Pro vs Enterprise plans',
    'What is the shipping policy?',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
