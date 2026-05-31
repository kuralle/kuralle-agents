import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { createRuntime, InMemoryMemoryService } from '@kuralle-agents/core';
import { createKuralleSseChatRouter } from '@kuralle-agents/hono-server';
import dotenv from 'dotenv';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';
import { loadTemplateEnv, resolveTemplateModel } from '@kuralle-templates/_shared-mock-services/runtime/model';
import { mergeHarnessTools } from '@kuralle-templates/_shared-mock-services/runtime/harnessTools';

loadTemplateEnv(import.meta.url);
dotenv.config();

const { model } = resolveTemplateModel();
const agents = buildAgents(model);

const runtime = createRuntime({
	agents,
	defaultAgentId: 'ops',
	defaultModel: model,
	knowledge: knowledgeConfig,
	memoryService: new InMemoryMemoryService(),
	tools: mergeHarnessTools(agents),
});

const app = new Hono();
app.use('/*', cors({ origin: '*' }));
app.get('/', (c) => c.json({ name: 'ops-bot', status: 'ready', agents: ['ops'] }));
app.route('/', createKuralleSseChatRouter({ runtime, streamFilter: 'all' }));

const port = Number(process.env.PORT ?? 3130);
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[ops-bot] listening on http://localhost:${info.port}`);
});
