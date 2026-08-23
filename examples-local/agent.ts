import { createOpenAI } from '@ai-sdk/openai';
import { defineAgent } from '@kuralle-agents/core';

export const agent = defineAgent({
  id: 'cafe',
  instructions: 'You are a cafe assistant. Be brief and friendly.',
  model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })('gpt-4.1-mini'),
});
