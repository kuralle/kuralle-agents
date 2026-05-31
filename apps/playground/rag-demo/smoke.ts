import dotenv from 'dotenv';
dotenv.config();

import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { runPlaygroundConversation } from '../_shared/runtime/smokeRunner.js';
import { buildAgents } from './agent.js';
import { ingestKnowledge } from './rag.js';

loadPlaygroundEnv(import.meta.url);

ingestKnowledge()
  .then(async () => {
    const { model, label } = resolvePlaygroundModel();
    await runPlaygroundConversation({
      title: `rag-demo live smoke (${label})`,
      agents: buildAgents(model),
      defaultAgentId: 'support',
      model,
      prompts: [
        'What is your refund policy?',
        'Compare the Pro and Enterprise plans.',
        'What are the shipping options for EU customers?',
      ],
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
