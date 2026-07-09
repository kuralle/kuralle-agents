#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const initialRole =
  "You are an inquisitive child. Use very simple language. Ask simple questions. Your responses will be converted to audio. Avoid outputting special characters and emojis.";
const initialTask = "Say 'Hello world' and ask what is the user's favorite color.";

const end = reply({
  id: 'end',
  instructions: 'Thank the user for answering and end the conversation',
  model,
  next: () => ({ end: 'completed' }),
});

const initial = collect({
  id: 'initial',
  schema: z.object({ color: z.string().min(1) }),
  required: ['color'],
  maxTurns: 8,
  instructions: () => `${initialRole}\n\n${initialTask}`,
  onComplete: () => end,
});

const agent = defineAgent({
  id: 'quickstart-hello-world',
  name: 'Quickstart Hello World',
  instructions: initialRole,
  model,
  flows: [
    defineFlow({
      name: 'hello',
      description: 'Say hello and collect favorite color',
      start: initial,
      nodes: [initial, end],
    }),
  ],
});

runV2Conversation({
  title: 'Pipecat Quickstart Hello World (v2)',
  agent,
  prompts: ['Hi!', 'My favorite color is blue.'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
