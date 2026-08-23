import { MockLanguageModelV3 } from 'ai/test';
import { defineAgent } from '@kuralle-agents/core';

/** A model that rejects the way a bad key or a network fault does — from inside the turn. */
export const agent = defineAgent({
  id: 'provider-failure',
  instructions: 'unused',
  model: new MockLanguageModelV3({
    doStream: async () => {
      throw new Error('Incorrect API key provided: bad-key.');
    },
    doGenerate: async () => {
      throw new Error('Incorrect API key provided: bad-key.');
    },
  }),
});
