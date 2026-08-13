import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import pg from '../../../postgres-store/node_modules/pg/lib/index.js';
import { appendFileSync } from 'node:fs';
import { createRuntime, defineAgent, defineTool } from '../../../core/dist/index.js';
import {
  PostgresSessionStore,
  PostgresRunStore,
  PostgresFlowDefinitionsStore,
} from '../../../postgres-store/dist/index.js';
import { createKuralleChatRouter, createStoredFlowsRouter } from '../../src/index.js';

const port = Number(process.env.E2E_PORT ?? 3877);
const counterFile = process.env.E2E_COUNTER_FILE!;
const connectionString = process.env.POSTGRES_URL!;

const charge = defineTool({
  name: 'charge',
  description: 'Charge the refund processing fee for an account id.',
  input: z.object({ accountId: z.string() }),
  execute: async ({ accountId }) => {
    appendFileSync(counterFile, `${accountId}\n`);
    return { accountId, charged: true, verdict: 'refund approved' };
  },
});

const clerk = defineAgent({
  id: 'clerk',
  name: 'Refund Clerk',
  model: openai('gpt-4o-mini'),
  instructions:
    'You are a refund clerk. When the user asks about a refund, enter the refund flow immediately. Keep replies short.',
  tools: { charge },
});

const pool = new pg.Pool({ connectionString, max: 8 });
const sessionStore = new PostgresSessionStore({ client: pool });
const runStore = new PostgresRunStore({ client: pool });
const flowStore = new PostgresFlowDefinitionsStore({ client: pool });

const runtime = createRuntime({
  agents: [clerk],
  defaultAgentId: 'clerk',
  sessionStore,
  runStore,
  flowDefinitionsStore: flowStore,
  defaultModel: openai('gpt-4o-mini'),
});

await runtime.loadDynamicFlows({ agentId: 'clerk' }).catch((error) => {
  console.error('loadDynamicFlows failed', error);
});

const app = new Hono();
app.route('/', createKuralleChatRouter({ runtime }));
app.route('/', createStoredFlowsRouter({ runtime, store: flowStore, agentId: 'clerk' }));

app.get('/e2e/runs', async (c) => {
  const refs = [];
  for await (const ref of runtime.getRunStore().listRuns({})) refs.push(ref);
  return c.json(refs);
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`E2E_READY ${port} pid=${process.pid}`);
});
