/**
 * CAG Demo Server — Bella's Italian Kitchen with LLM-based retrieval.
 */

import dotenv from 'dotenv';
dotenv.config();

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { createKuralleSseChatRouter } from '@kuralle-agents/hono-server';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../_shared/runtime/model.js';
import { mergeHarnessTools } from '../_shared/runtime/harnessTools.js';
import { buildAgents } from './agent.js';

loadPlaygroundEnv(import.meta.url);
const { model } = resolvePlaygroundModel();
const agents = buildAgents(model);

const runtime = createRuntime({
  agents,
  defaultAgentId: 'bella',
  defaultModel: model,
  sessionStore: new MemoryStore(),
  tools: mergeHarnessTools(agents),
});

const app = new Hono();
app.use('/*', cors({ origin: '*' }));
app.get('/health', (c) => c.json({ status: 'ok', demo: 'cag' }));
app.route('/', createKuralleSseChatRouter({ runtime, streamFilter: 'all' }));

const port = Number(process.env.PORT ?? 3335);
serve({ fetch: app.fetch, port }, () => {
  console.log(`CAG Demo: http://localhost:${port}`);
});
