#!/usr/bin/env node

/**
 * Memory Demo — Long-term memory across sessions (v2)
 */

import { openai } from '@ai-sdk/openai';
import readline from 'readline';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { createLoadMemoryTool } from '../../../src/tools/memory.js';
import { wrapAiSdkTool } from '../../../src/tools/effect/wrapAiSdkTool.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { InMemoryMemoryService } from '../../../src/memory/stores/InMemoryMemoryService.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { loadExampleEnv } from '../../_shared/v2Runner.js';

const memoryService = new InMemoryMemoryService();

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const model = openai('gpt-4o-mini');

const agent = defineAgent({
  id: 'memory-agent',
  name: 'Memory Agent',
  model,
  instructions: `You are a helpful assistant with long-term memory.
You can remember things from past conversations with the user.
When the user asks about something discussed previously, use the loadMemory tool to search your memory.
Be conversational and refer to past context naturally.`,
  tools: { loadMemory: wrapAiSdkTool('loadMemory', createLoadMemoryTool()) },
  memory: {
    preload: { enabled: true },
    ingest: { enabled: true },
  },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore: new MemoryStore(),
  memoryService,
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

const USER_ID = 'demo-user-1';

async function runSession(sessionNum: number) {
  const sessionId = `session-${sessionNum}`;
  console.log(`\n--- Session ${sessionNum} (${sessionId}) ---`);
  console.log('Type "done" to end this session, "quit" to exit.\n');

  while (true) {
    const input = await ask('You: ');
    if (input.trim() === 'done') break;
    if (input.trim() === 'quit') {
      rl.close();
      process.exit(0);
    }

    process.stdout.write('Agent: ');
    const handle = runtime.run({ sessionId, input, userId: USER_ID });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') process.stdout.write(part.delta);
    }
    await handle;
    console.log();
  }

  console.log(`\nSession ${sessionNum} ended. Memories have been ingested.`);
}

async function main() {
  console.log('=== Kuralle Memory Demo (v2) ===');
  console.log('This demo shows cross-session memory.');
  console.log('Chat in Session 1, then start Session 2 to see memory recall.\n');

  let sessionNum = 1;
  while (true) {
    await runSession(sessionNum);
    const next = await ask('\nStart another session? (y/n): ');
    if (next.toLowerCase() !== 'y') break;
    sessionNum++;
  }

  rl.close();
}

main().catch(console.error);
