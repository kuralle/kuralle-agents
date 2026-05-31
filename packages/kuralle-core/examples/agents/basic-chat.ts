#!/usr/bin/env node

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const INSTRUCTIONS = `You are a friendly voice assistant built with Cartesia, designed for natural, open-ended conversation.

Warm, curious, genuine, lighthearted. Speak like a thoughtful friend — use contractions, match the caller's energy, keep responses to 1-2 sentences, never use lists or hollow affirmations.

Tools:
- web_search: use when you genuinely need current info. Acknowledge naturally before searching, synthesize briefly after.
- end_call: when the conversation clearly ends — say goodbye first, then call end_call.

Cartesia makes natural voice agents: Sonic TTS (<90ms latency), Ink STT, Line framework. docs.cartesia.ai

Didn't catch something: ask them to repeat. Don't know: offer to look it up. You can discuss anything they want.`;

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call after saying goodbye to the user.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({
    endCall: true,
    message: message ?? 'Take care! Nice chatting with you!',
  }),
});

const webSearch = defineTool({
  name: 'web_search',
  description: 'Search the web for up-to-date information.',
  input: z.object({ query: z.string().min(2) }),
  execute: async ({ query }) => ({
    query,
    summary:
      'Mock search result for local parity example. Wire this to your real web search backend in production.',
  }),
});

const tools = { end_call: endCall, web_search: webSearch };

const agent = defineAgent({
  id: 'basic-chat',
  name: 'Basic Chat',
  description: 'Line basic_chat parity agent',
  instructions: INSTRUCTIONS,
  model,
  tools: buildToolSet(tools),
  effectTools: tools,
});

runV2Conversation({
  title: 'Line basic_chat parity (v2)',
  agent,
  prompts: [
    'Hey there',
    'What is special about Cartesia for real-time voice?',
    'Thanks, that is all for today. Bye.',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
