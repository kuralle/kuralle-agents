#!/usr/bin/env bun
/**
 * Working memory — cross-session USER block persistence via memory_block.
 *
 * Session 1: agent records a user preference with memory_block.
 * Session 2 (new session, same userId): preference appears in the injected
 * working-memory prompt and the agent recalls it without calling the tool.
 */
import { defineAgent, createRuntime } from '../../src/index.js';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { loadExampleEnv, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

const live = requireLiveModel();
const store = new InMemoryPersistentMemoryStore();
const userId = `wm-demo-${Date.now()}`;

const agent = defineAgent({
  id: 'memory-demo',
  model: live.model,
  instructions: `You remember user preferences across sessions via working memory blocks.
When the user asks you to remember something, call memory_block with action add, block USER, and a short factual entry.
When asked about a stored preference, answer from the "## Working memory" section in your system prompt first.
Keep responses to one short sentence.`,
  memory: {
    workingMemory: {
      store,
      autoLoad: [{ scope: 'user', key: 'USER' }],
    },
  },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: live.model,
  sessionStore: new MemoryStore(),
});

async function runTurn(sessionId: string, input: string): Promise<string> {
  let text = '';
  const handle = runtime.run({ sessionId, input, userId });
  for await (const part of handle.events) {
    if (part.type === 'text-delta') text += part.delta;
    if (part.type === 'tool-call') console.log(`  [tool] ${part.toolName}`);
  }
  await handle;
  return text.trim();
}

async function main() {
  console.log(`Working memory demo (${live.label})`);
  console.log(`userId: ${userId}\n`);

  const session1 = `wm-s1-${Date.now()}`;
  console.log('--- Session 1 ---');
  const r1 = await runTurn(session1, 'Remember that my favorite color is teal.');
  console.log(`Assistant: ${r1}\n`);

  const saved = await store.loadBlock('user', userId, 'USER');
  if (!saved?.content.includes('teal')) {
    console.error('Session 1 did not persist USER block via memory_block:', saved);
    process.exit(1);
  }

  const session2 = `wm-s2-${Date.now()}`;
  console.log('--- Session 2 (new session, same user) ---');
  const r2 = await runTurn(session2, 'What is my favorite color?');
  console.log(`Assistant: ${r2}\n`);

  if (!/teal/i.test(r2)) {
    console.error('Expected session 2 to recall "teal" from injected working memory.');
    process.exit(1);
  }

  console.log('OK — cross-session working memory recalled from injected USER block.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
