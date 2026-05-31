/**
 * RAG Demo Server — Acme Corp support with vector search.
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
import { ingestKnowledge } from './rag.js';

async function main() {
  loadPlaygroundEnv(import.meta.url);
  await ingestKnowledge();

  const { model } = resolvePlaygroundModel();
  const agents = buildAgents(model);

  const runtime = createRuntime({
    agents,
    defaultAgentId: 'support',
    defaultModel: model,
    sessionStore: new MemoryStore(),
    tools: mergeHarnessTools(agents),
  });

  const app = new Hono();
  app.use('/*', cors({ origin: '*' }));
  app.get('/health', (c) => c.json({ status: 'ok', demo: 'rag' }));
  app.route('/', createKuralleSseChatRouter({ runtime, streamFilter: 'all' }));

  const port = Number(process.env.PORT ?? 3334);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`RAG Demo: http://localhost:${port}`);
  });
}

main().catch(console.error);
