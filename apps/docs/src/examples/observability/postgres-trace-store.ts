import { Pool } from 'pg';
import { openai } from '@ai-sdk/openai';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { PostgresTraceStore } from '@kuralle-agents/postgres-store';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: {
    store: new PostgresTraceStore({ client: pool, retentionMs: 7 * 24 * 60 * 60 * 1000 }),
  },
});
