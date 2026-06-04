#!/usr/bin/env node

/**
 * Memory Validation Script — Full pipeline inspection (v2)
 */

import { openai } from '@ai-sdk/openai';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { createLoadMemoryTool } from '../../../src/tools/memory.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { InMemoryMemoryService } from '../../../src/memory/stores/InMemoryMemoryService.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { preloadMemoryContext } from '../../../src/memory/preloadMemory.js';
import type { Session } from '../../../src/types/session.js';
import { loadExampleEnv } from '../../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

function log(label: string, data: unknown) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(60)}`);
  if (typeof data === 'string') console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

function separator(title: string) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'━'.repeat(60)}`);
}

const memoryService = new InMemoryMemoryService();
const sessionStore = new MemoryStore();
const model = openai('gpt-4o-mini');

const agent = defineAgent({
  id: 'memory-agent',
  name: 'Memory Agent',
  model,
  instructions: `You are a helpful assistant with long-term memory.
You can remember things from past conversations.
When the user refers to something from before, recall it naturally.
Keep responses concise (1-2 sentences).`,
  tools: { loadMemory: createLoadMemoryTool() },
  memory: {
    preload: { enabled: true, tokenBudget: 5000 },
    ingest: { enabled: true },
  },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore,
  memoryService,
});

async function chat(
  sessionId: string,
  userId: string,
  input: string,
): Promise<{ response: string; events: string[] }> {
  let response = '';
  const events: string[] = [];
  const handle = runtime.run({ sessionId, input, userId });
  for await (const part of handle.events) {
    events.push(part.type);
    if (part.type === 'text-delta') response += part.delta;
    if (part.type === 'error') console.error('  [ERROR event]', part.error);
  }
  await handle;
  return { response, events };
}

async function main() {
  const USER_ID = 'validation-user';

  separator('SESSION 1: Establishing facts');

  const turn1 = await chat('session-1', USER_ID, 'My name is Alex and I live in Tokyo.');
  log('Turn 1 — Events', turn1.events);
  log('Turn 1 — Response', turn1.response || '(empty)');

  const turn2 = await chat('session-1', USER_ID, 'My favorite food is ramen, especially tonkotsu.');
  log('Turn 2 — Events', turn2.events);
  log('Turn 2 — Response', turn2.response || '(empty)');

  const turn3 = await chat('session-1', USER_ID, 'I work at NeonLabs as a software engineer.');
  log('Turn 3 — Events', turn3.events);
  log('Turn 3 — Response', turn3.response || '(empty)');

  const session1 = await sessionStore.get('session-1');
  if (session1) {
    log('Session 1 — Total messages', session1.messages.length);
    log(
      'Session 1 — Message breakdown',
      session1.messages
        .map((m, i) => {
          const content =
            typeof m.content === 'string'
              ? m.content.slice(0, 100)
              : Array.isArray(m.content)
                ? `[${m.content.map((p) => (p as { type?: string }).type).join(', ')}]`
                : '[unknown]';
          return `  ${i}: [${m.role}] ${content}`;
        })
        .join('\n'),
    );
  }

  separator('MEMORY INSPECTION');

  const allMemories = await memoryService.searchMemory({
    userId: USER_ID,
    query: 'Alex Tokyo ramen NeonLabs name food work',
    limit: 20,
  });
  log('Total memories found', allMemories.memories.length);
  for (const mem of allMemories.memories) {
    console.log(
      `  [score=${mem.score?.toFixed(2)}] [author=${mem.author}] [session=${mem.sessionId}] ${mem.content.slice(0, 120)}`,
    );
  }

  const mockSession: Session = {
    id: 'mock',
    conversationId: 'mock-conversation',
    channelId: 'api',
    userId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    workingMemory: {},
    currentAgent: 'memory-agent',
    agentStates: {},
    handoffHistory: [],
  };

  const preloadName = await preloadMemoryContext(memoryService, mockSession, 'What is my name?', 5000);
  log('preloadMemoryContext("What is my name?")', preloadName ?? '(null)');

  separator('SESSION 2: Cross-session recall');

  const s2t1 = await chat('session-2', USER_ID, 'What is my name and where do I live?');
  log('Turn 1 — Events', s2t1.events);
  log('Turn 1 — Response', s2t1.response || '(empty)');

  const r1 = s2t1.response.toLowerCase();
  console.log(`\n  Recall check: "alex" → ${r1.includes('alex') ? '✓' : '✗'}`);
  console.log(`  Recall check: "tokyo" → ${r1.includes('tokyo') ? '✓' : '✗'}`);

  const s2t2 = await chat('session-2', USER_ID, 'What food do I like?');
  log('Turn 2 — Response', s2t2.response || '(empty)');
  const r2 = s2t2.response.toLowerCase();
  console.log(`  Recall check: "ramen" → ${r2.includes('ramen') ? '✓' : '✗'}`);

  const s2t3 = await chat('session-2', USER_ID, 'Where do I work?');
  log('Turn 3 — Response', s2t3.response || '(empty)');
  const r3 = s2t3.response.toLowerCase();
  console.log(
    `  Recall check: "neonlabs"/"neon" → ${r3.includes('neonlabs') || r3.includes('neon') ? '✓' : '✗'}`,
  );

  separator('MEMORY DELETION');
  await memoryService.deleteMemories(USER_ID);
  const afterDel = await memoryService.searchMemory({ userId: USER_ID, query: 'anything' });
  log(
    'After deletion',
    afterDel.memories.length === 0 ? 'EMPTY ✓' : `${afterDel.memories.length} entries remain ✗`,
  );

  separator('VALIDATION SUMMARY');
  const checks = [
    ['Agent produces responses', turn1.response.length > 0],
    ['Assistant messages in session', (session1?.messages.filter((m) => m.role === 'assistant').length ?? 0) > 0],
    ['Memory ingestion works', allMemories.memories.length > 0],
    ['preloadMemory returns content', preloadName !== null],
    ['Agent recalls name (alex)', r1.includes('alex')],
    ['Agent recalls food (ramen)', r2.includes('ramen')],
    ['Memory deletion works', afterDel.memories.length === 0],
  ];

  let passCount = 0;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${name}`);
    if (pass) passCount++;
  }
  console.log(`\n  Result: ${passCount}/${checks.length} checks passed\n`);

  process.exit(passCount === checks.length ? 0 : 1);
}

main().catch((err) => {
  console.error('Validation failed with error:', err);
  process.exit(1);
});
