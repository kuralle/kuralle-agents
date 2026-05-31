#!/usr/bin/env node

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call after a natural goodbye.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({ endCall: true, message: message ?? 'Gracias. Adios!' }),
});

const transferToSpanish = defineTool({
  name: 'transfer_to_spanish',
  description: 'Transfer to a Spanish-speaking agent when the user requests Spanish.',
  input: z.object({ reason: z.string().default('User requested Spanish support') }),
  execute: async ({ reason }) => ({
    __handoff: true,
    targetAgentId: 'spanish-agent',
    reason,
    message: 'Transferring you to our Spanish-speaking agent now...',
  }),
});

const spanishAgent = defineAgent({
  id: 'spanish-agent',
  name: 'Spanish Agent',
  instructions: 'Eres un asistente amable y servicial. Tenga una conversacion natural con el usuario. Habla solo en espanol.',
  model,
  tools: buildToolSet({ end_call: endCall }),
  effectTools: { end_call: endCall },
});

const englishTools = { end_call: endCall, transfer_to_spanish: transferToSpanish };

const englishAgent = defineAgent({
  id: 'english-agent',
  name: 'English Agent',
  instructions:
    'Friendly assistant. If the user asks to speak in Spanish or requests a Spanish speaker, use transfer_to_spanish.',
  model,
  handoffs: ['spanish-agent'],
  agents: [spanishAgent],
  tools: buildToolSet(englishTools),
  effectTools: englishTools,
});

runV2Conversation({
  title: 'Line transfer_agent parity (v2)',
  agent: englishAgent,
  agents: [englishAgent, spanishAgent],
  prompts: ['Hello there', 'Can we speak in Spanish?', 'Gracias, eso es todo.'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
