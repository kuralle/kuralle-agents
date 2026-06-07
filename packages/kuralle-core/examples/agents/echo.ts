#!/usr/bin/env node

import { z } from 'zod';
import type { OutputProcessor } from '../../src/types/processors.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

let activeEchoPrefix: string | null = null;

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo the user message back with a prefix after echo mode is activated.',
  input: z.object({ prefix: z.string() }),
  execute: async ({ prefix }) => {
    if (activeEchoPrefix) {
      return { activated: false, prefix: activeEchoPrefix, message: `Echo mode is already active with ${activeEchoPrefix}` };
    }
    activeEchoPrefix = prefix;
    return { activated: true, prefix, message: `Echo mode activated! I will prefix everything with ${prefix}` };
  },
});

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call after a natural sign-off.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => {
    activeEchoPrefix = null;
    return { endCall: true, message: message ?? 'Goodbye!' };
  },
});

const echoOutputProcessor: OutputProcessor = {
  id: 'echo-output-rewriter',
  process: ({ text, messages }) => {
    if (!activeEchoPrefix || /echo mode activated/i.test(text)) return { action: 'allow' };
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
    if (!lastUser || typeof lastUser.content !== 'string') return { action: 'allow' };
    const echoed = `${activeEchoPrefix}: ${lastUser.content}`;
    return text.trim() === echoed.trim() ? { action: 'allow' } : { action: 'modify', text: echoed, reason: 'Echo mode is active' };
  },
};

const tools = { end_call: endCall, echo: echoTool };

const agent = defineAgent({
  id: 'echo-agent',
  name: 'Echo Agent',
  instructions:
    'Friendly assistant. Call echo once when the user says they are ready to talk to themselves. After echo mode is active, do not call echo again. On goodbye, call end_call briefly.',
  model,
  tools: tools,
  guardrails: { output: [echoOutputProcessor] },
});

runV2Conversation({
  title: 'Line echo parity (v2)',
  agent,
  prompts: ['Hi there', "I'm ready to talk to myself", 'This should get echoed', 'Thanks bye'],
  onPart: (part) => {
    if (part.type === 'tool-result') console.log(`[Tool result] ${part.toolName} => ${JSON.stringify(part.result)}`);
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
