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
app.use('/*', cors({ origin: '*' }));
app.get('/', (c) =>
	c.json({
		name: 'cedar-health',
		status: 'ready',
		agents: agents.map((a) => a.id),
		seedMRNs: ['MRN-100231 (Amy Chen, DOB 1981-04-12)', 'MRN-100410 (Jose Rivera, DOB 1957-09-03)'],
	}),
);
app.route('/', createKuralleSseChatRouter({ runtime, streamFilter: 'all' }));

const port = Number(process.env.PORT ?? 3150);
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`[cedar-health] http://localhost:${info.port}`);
});
