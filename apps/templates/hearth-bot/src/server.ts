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
	defaultAgentId: 'coordinator',
	defaultModel: model,
	knowledge: knowledgeConfig,
	memoryService: new InMemoryMemoryService(),
	tools: mergeHarnessTools(agents),
});

const app = new Hono();
app.use('/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] }));

app.get('/', (c) =>
	c.json({
		name: 'hearth-bot',
		status: 'ready',
		endpoints: ['POST /api/chat/sse'],
		agents: agents.map((a) => a.id),
	}),
);

app.route('/', createKuralleSseChatRouter({ runtime, streamFilter: 'all' }));

const port = Number(process.env.PORT ?? 3120);
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[hearth-bot] listening on http://localhost:${info.port}`);
});
