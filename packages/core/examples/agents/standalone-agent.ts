#!/usr/bin/env node
/** Standalone defineAgent + createRuntime — single-turn, stream, tools, and supervisor tool. */

import { generateText } from 'ai';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import { loadExampleEnv, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model, label } = requireLiveModel();

async function example1() {
  console.log('\n========================================\n  Example 1: runtime.run() (single turn)\n========================================\n');
  const poet = defineAgent({
    id: 'poet',
    name: 'Poet',
    model,
    instructions: 'You are a poet. Write short, elegant poems. Max 4 lines.',
  });
  const runtime = createRuntime({
    agents: [poet],
    defaultAgentId: 'poet',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const handle = runtime.run({ sessionId: newSessionId(), input: 'Write a poem about TypeScript.' });
  let text = '';
  for await (const part of handle.events) {
    if (part.type === 'text-delta') text += part.delta;
  }
  await handle;
  console.log('Poem:\n\n' + text);
}

async function example2() {
  console.log('\n========================================\n  Example 2: streaming text-delta\n========================================\n');
  const storyteller = defineAgent({
    id: 'storyteller',
    name: 'Storyteller',
    model,
    instructions: 'Tell very short stories (3-4 sentences max).',
  });
  const runtime = createRuntime({
    agents: [storyteller],
    defaultAgentId: 'storyteller',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  process.stdout.write('Story: ');
  const handle = runtime.run({
    sessionId: newSessionId(),
    input: 'Tell me a story about a robot who learned to cook.',
  });
  for await (const part of handle.events) {
    if (part.type === 'text-delta') process.stdout.write(part.delta);
  }
  await handle;
  console.log('\n');
}

async function example3() {
  console.log('\n========================================\n  Example 3: Agent with tools\n========================================\n');
  const calculator = defineTool({
    description: 'Perform a math calculation',
    input: z.object({ expression: z.string() }),
    execute: async ({ expression }) => {
      try {
        const result = Function(`"use strict"; return (${expression})`)();
        return { expression, result: String(result) };
      } catch {
        return { expression, result: 'Error: invalid expression' };
      }
    },
  });
  const mathTutor = defineAgent({
    id: 'math-tutor',
    name: 'Math Tutor',
    model,
    instructions: 'Math tutor. Use calculator for problems. Show your work.',
    tools: { calculator },
  });
  const runtime = createRuntime({
    agents: [mathTutor],
    defaultAgentId: 'math-tutor',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  console.log('Question: What is 47 * 83 + 156?\n');
  const handle = runtime.run({ sessionId: newSessionId(), input: 'What is 47 * 83 + 156?' });
  for await (const part of handle.events) {
    if (part.type === 'text-delta' && part.delta) process.stdout.write(part.delta);
    if (part.type === 'tool-call') console.log(`\n  [Tool call: ${part.toolName}(${JSON.stringify(part.args)})]`);
    if (part.type === 'tool-result') console.log(`  [Tool result: ${JSON.stringify(part.result)}]\n`);
  }
  await handle;
  console.log('\n');
}

async function example4() {
  console.log('\n========================================\n  Example 4: specialist tool (supervisor pattern)\n========================================\n');
  const historian = defineTool({
    name: 'consult_historian',
    description: 'Ask the historian a question',
    input: z.object({ question: z.string() }),
    execute: async ({ question }) => {
      const { text } = await generateText({
        model,
        system: 'History expert. Brief factual answers. Max 2 sentences.',
        prompt: question,
      });
      return { agentId: 'historian', response: text };
    },
  });
  const scientist = defineTool({
    name: 'consult_scientist',
    description: 'Ask the scientist a question',
    input: z.object({ question: z.string() }),
    execute: async ({ question }) => {
      const { text } = await generateText({
        model,
        system: 'Science expert. Brief factual answers. Max 2 sentences.',
        prompt: question,
      });
      return { agentId: 'scientist', response: text };
    },
  });
  const tools = { consult_historian: historian, consult_scientist: scientist };
  const lead = defineAgent({
    id: 'lead',
    name: 'Research Assistant',
    model,
    instructions:
      'Research assistant. Use consult_historian for history, consult_scientist for science. Combine answers clearly.',
    tools: tools,
  });
  const runtime = createRuntime({
    agents: [lead],
    defaultAgentId: 'lead',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  console.log('Question: Who discovered penicillin and how does it work?\n');
  const handle = runtime.run({
    sessionId: newSessionId(),
    input: 'Who discovered penicillin and how does it work?',
  });
  for await (const part of handle.events) {
    if (part.type === 'text-delta' && part.delta) process.stdout.write(part.delta);
    if (part.type === 'tool-call') console.log(`\n  [Consulting ${part.toolName}...]`);
    if (part.type === 'tool-result') {
      const result = part.result as { agentId: string; response: string };
      console.log(`  [${result.agentId} says: "${result.response.slice(0, 80)}..."]\n`);
    }
  }
  await handle;
  console.log('\n');
}

async function example5() {
  console.log('\n========================================\n  Example 5: multi-turn session\n========================================\n');
  const translate = defineTool({
    name: 'translate',
    description: 'Translate text to Spanish',
    input: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      const { text: translation } = await generateText({
        model,
        system: 'You are a translator. Translate the given text to Spanish. Return only the translation.',
        prompt: text,
      });
      return { translation };
    },
  });

  const assistant = defineAgent({
    id: 'assistant',
    name: 'Bilingual Assistant',
    instructions:
      'Bilingual assistant. When asked to translate, use the translate tool and present original + translation.',
    model,
    tools: { translate },
  });

  const runtime = createRuntime({
    agents: [assistant],
    defaultAgentId: 'assistant',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const sessionId = newSessionId();

  async function turn(input: string) {
    console.log(`User: ${input}\n`);
    const handle = runtime.run({ sessionId, input });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') process.stdout.write(part.delta);
    }
    await handle;
    console.log('\n');
  }

  await turn('Translate "Hello, how are you today?" to Spanish');
  await turn('Now translate "I love programming" as well');
}

async function main() {
  console.log('============================================================');
  console.log('  Standalone Agent Examples (defineAgent + createRuntime)');
  console.log(`  Model: ${label}`);
  console.log('============================================================');
  await example1();
  await example2();
  await example3();
  await example4();
  await example5();
  console.log(
    '============================================================\n  All examples complete.\n============================================================\n',
  );
}

main().catch(console.error);
