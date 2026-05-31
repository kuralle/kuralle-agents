#!/usr/bin/env node

import { generateText } from 'ai';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model, label } = requireLiveModel();

const CHAT_INSTRUCTIONS = `Friendly voice assistant. Handle routine questions yourself; use ask_supervisor for complex math, proofs, multi-step logic, or when accuracy is critical.

When calling ask_supervisor: acknowledge immediately, wait for the response, synthesize naturally. Never mention a supervisor or another model.

Keep responses conversational and short — no markdown. Use end_call when the caller says goodbye (say goodbye first).`;

const SUPERVISOR_INSTRUCTIONS = `Deep reasoning assistant. Provide thorough, voice-friendly analysis. Walk through math/logic step-by-step. Be accurate and practical.`;

const askSupervisor = defineTool({
  name: 'ask_supervisor',
  description: 'Consult a more powerful reasoning model for complex questions.',
  input: z.object({ question: z.string() }),
  execute: async ({ question }) => {
    const { text } = await generateText({
      model,
      system: SUPERVISOR_INSTRUCTIONS,
      prompt: question,
    });
    return { status: 'complete', answer: text };
  },
});

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call after a natural goodbye.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({ endCall: true, message: message ?? 'Nice talking with you. Take care!' }),
});

const tools = { ask_supervisor: askSupervisor, end_call: endCall };

const agent = defineAgent({
  id: 'chat-supervisor',
  name: 'Chat Supervisor Agent',
  instructions: CHAT_INSTRUCTIONS,
  model,
  tools: buildToolSet(tools),
  effectTools: tools,
});

console.log("Intro: Hey! I'm here to help with whatever is on your mind. What would you like to talk about?");
console.log(`Supervisor model: ${label}`);

runV2Conversation({
  title: 'Line chat_supervisor parity (v2)',
  agent,
  prompts: ['Hi there', 'Can you prove square root of two is irrational?', 'Thanks that helped, bye.'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
