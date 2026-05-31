import dotenv from 'dotenv';
dotenv.config();

import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { runPlaygroundConversation } from '../_shared/runtime/smokeRunner.js';
import { buildAgents } from './agent.js';

loadPlaygroundEnv(import.meta.url);
const { model, label } = resolvePlaygroundModel();

runPlaygroundConversation({
  title: `cag-demo live smoke (${label})`,
  agents: buildAgents(model),
  defaultAgentId: 'bella',
  model,
  prompts: [
    'What pasta dishes do you have and what are the prices?',
    'Do you have gluten-free options?',
    'What desserts are on the menu?',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
