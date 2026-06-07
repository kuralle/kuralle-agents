/**
 * Working memory with a FLOW agent.
 * The agent is flow-driven (a conversational `reply` node, hybrid). Verifies that
 * working memory is injected into flow-node prompts AND the memory_block tool is
 * available inside the flow — so a flow agent remembers across sessions.
 *   KURALLE_EXAMPLE_PROVIDER=openai bun examples/agents/flow-memory.ts
 */
import { defineAgent, createRuntime, MemoryStore } from '../../src/index.js';
import { reply, defineFlow } from '../../src/authoring/nodes.js';
import { InMemoryPersistentMemoryStore } from '../../src/memory/blocks/InMemoryPersistentMemoryStore.js';
import { loadExampleEnv, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model, label } = requireLiveModel();

const store = new InMemoryPersistentMemoryStore();
const userId = `flow-wm-${Date.now()}`;

// A minimal conversational flow: one reply node that stays (loops) — the agent IS flow-driven.
const concierge = reply({
  id: 'concierge',
  instructions: 'You are a friendly concierge. Help the user and answer their questions concisely.',
  model,
  next: () => 'stay',
});

const agent = defineAgent({
  id: 'flow-mem',
  model,
  flows: [defineFlow({ name: 'concierge', description: 'General help', start: concierge, nodes: [concierge] })],
  memory: { workingMemory: { store, autoLoad: [{ scope: 'user', key: 'USER' }] } },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'flow-mem',
  defaultModel: model,
  sessionStore: new MemoryStore(),
});

async function turn(sessionId: string, input: string): Promise<string> {
  return (await runtime.run({ sessionId, input, userId })).text ?? '';
}

console.log(`Flow + working memory (${label}) — userId=${userId}`);
console.log('--- Session 1 (flow agent): share a fact ---');
console.log('assistant:', await turn('flow-s1', 'Please remember that my favorite color is teal and my name is Sam.'));

const saved = await store.loadBlock('user', userId, 'USER');
console.log('USER block after session 1:', JSON.stringify(saved?.content ?? null));

console.log('--- Session 2 (new session, same user, same flow agent): recall ---');
const recall = await turn('flow-s2', 'What is my favorite color and my name?');
console.log('assistant:', recall);

const ok = /teal/i.test(recall) && /sam/i.test(recall);
console.log(ok
  ? 'OK — a FLOW-driven agent stored + recalled working memory across sessions (memory injected into flow-node prompts).'
  : 'FAIL — flow agent did not recall the stored facts.');
process.exit(ok ? 0 : 1);
