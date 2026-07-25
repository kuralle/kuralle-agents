import type { LanguageModel } from 'ai';
import type { Session } from '../../src/types/session.js';
import type { RunState } from '../../src/runtime/durable/types.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';

const sessionId = 'durable-parallel-example';
const session: Session = {
  id: sessionId,
  conversationId: sessionId,
  channelId: 'example',
  createdAt: new Date(),
  updatedAt: new Date(),
  messages: [],
  workingMemory: {},
  currentAgent: 'example-agent',
  agentStates: {},
  handoffHistory: [],
};
const runState: RunState = {
  runId: sessionId,
  sessionId,
  status: 'running',
  activeAgentId: 'example-agent',
  state: {},
  messages: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const counts = { inventory: 0, shipping: 0, tax: 0 };
const tools = {
  lookup_inventory: {
    name: 'lookup_inventory',
    description: 'Look up inventory',
    execute: async () => {
      counts.inventory += 1;
      return { available: true };
    },
  },
  quote_shipping: {
    name: 'quote_shipping',
    description: 'Quote shipping',
    execute: async () => {
      counts.shipping += 1;
      return { cents: 799 };
    },
  },
  calculate_tax: {
    name: 'calculate_tax',
    description: 'Calculate tax',
    execute: async () => {
      counts.tax += 1;
      return { cents: 1250 };
    },
  },
};

const toolExecutor = {
  getTool: (name: string) => tools[name as keyof typeof tools],
  execute: async (args: { name: string }) => {
    const tool = tools[args.name as keyof typeof tools];
    if (!tool) throw new Error(`Unknown tool: ${args.name}`);
    return tool.execute();
  },
};

const memoryStore = new MemoryStore();
await memoryStore.save(session);
const runStore = new SessionRunStore(memoryStore, sessionId);
await runStore.initRun(runState);

async function buildContext() {
  return createRunContext({
    session,
    runState: (await runStore.getRunState(sessionId)) ?? runState,
    runStore,
    steps: await runStore.getSteps(sessionId),
    toolExecutor,
    model: {} as LanguageModel,
  });
}

const firstContext = await buildContext();
const firstResults = await Promise.all([
  firstContext.tool('lookup_inventory', {}),
  firstContext.tool('quote_shipping', {}),
  firstContext.tool('calculate_tax', {}),
]);
const liveSteps = await runStore.getSteps(sessionId);

if (
  liveSteps.map((step) => step.index).join(',') !== '0,1,2' ||
  liveSteps.some((step) => step.status !== 'finished')
) {
  throw new Error(`Unexpected live journal: ${JSON.stringify(liveSteps)}`);
}

const replayContext = await buildContext();
const replayResults = await Promise.all([
  replayContext.tool('lookup_inventory', {}),
  replayContext.tool('quote_shipping', {}),
  replayContext.tool('calculate_tax', {}),
]);

if (JSON.stringify(replayResults) !== JSON.stringify(firstResults) || JSON.stringify(counts) !== '{"inventory":1,"shipping":1,"tax":1}') {
  throw new Error(`Replay was not idempotent: ${JSON.stringify({ replayResults, counts })}`);
}

console.log('parallel ctx.tool live results:', JSON.stringify(firstResults));
console.log('journal indices:', liveSteps.map((step) => step.index).join(','));
console.log('execution counts after replay:', JSON.stringify(counts));
console.log('PASS: concurrent ctx.tool calls journal once and replay without re-execution');
