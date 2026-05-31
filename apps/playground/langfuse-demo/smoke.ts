import { config } from 'dotenv';
config();

import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { runPlaygroundConversation } from '../_shared/runtime/smokeRunner.js';
import { buildAgents } from './agents.js';

loadPlaygroundEnv(import.meta.url);
const { model, label } = resolvePlaygroundModel();

runPlaygroundConversation({
  title: `langfuse-demo live smoke (${label})`,
  agents: buildAgents(model),
  defaultAgentId: 'router',
  model,
  prompts: [
    'Where is my order 12345?',
    'Can you check my invoice?',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
