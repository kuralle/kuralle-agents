/**
 * Acme Corp Support Agent — HTTP Server
 *
 * Prerequisites: Run `bun run ingest` first.
 */

import { config } from 'dotenv';
config();

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { createKuralleSseChatRouter } from '@kuralle-agents/hono-server';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../../_shared/runtime/model.js';
import { mergeHarnessTools } from '../../_shared/runtime/harnessTools.js';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';

loadPlaygroundEnv(import.meta.url);
const { model } = resolvePlaygroundModel();
const agents = buildAgents(model);

const runtime = createRuntime({
  agents,
  defaultAgentId: 'triage',
  defaultModel: model,
  sessionStore: new MemoryStore(),
  knowledge: knowledgeConfig,
  tools: mergeHarnessTools(agents),
});

const app = new Hono();
app.use('/*', cors({ origin: '*' }));
app.get('/health', (c) => c.json({ status: 'ok', demo: 'acme-support-agent' }));
app.route('/', createKuralleSseChatRouter({ runtime, streamFilter: 'all' }));

const port = Number(process.env.PORT ?? 3335);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Acme Support Agent: http://localhost:${port}`);
});
