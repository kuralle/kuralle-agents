/**
 * Live cross-process durability smoke for PostgresPersistentMemoryStore.
 *   bun examples/wm-pg-smoke.ts 1 <userId>   # process 1: agent stores a preference -> Postgres
 *   bun examples/wm-pg-smoke.ts 2 <userId>   # process 2 (fresh): agent recalls it from Postgres
 * Requires OPENAI_API_KEY and a reachable Postgres (PG_URL or default localhost db).
 */
import { SQL } from 'bun';
import { createOpenAI } from '@ai-sdk/openai';
import { defineAgent, createRuntime } from '@kuralle-agents/core';
import { MemoryStore } from '@kuralle-agents/core';
import { PostgresPersistentMemoryStore } from '@kuralle-agents/postgres-store';

const phase = process.argv[2] ?? '1';
const userId = process.argv[3] ?? `wm-pg-${Date.now()}`;
const PG_URL = process.env.PG_URL ?? 'postgresql://localhost:5432/kuralle_wm_smoke';

const sql = new SQL(PG_URL);
// Minimal PostgresClient over Bun.sql ({ query(text, params) -> { rows } }).
const client = {
  async query(text: string, params?: unknown[]) {
    const rows = await sql.unsafe(text, (params as never[]) ?? []);
    return { rows: rows as unknown[] };
  },
};

const store = new PostgresPersistentMemoryStore({ client: client as never });

const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })('gpt-4o-mini');

const agent = defineAgent({
  id: 'wm-pg-demo',
  model,
  // NEUTRAL instructions — no mention of memory_block. Storage must be driven by the
  // framework's working-memory directive (Mastra-informed), not the developer's prompt.
  instructions: `You are a friendly assistant. Be concise.`,
  memory: { workingMemory: { store, autoLoad: [{ scope: 'user', key: 'USER' }] } },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'wm-pg-demo',
  defaultModel: model,
  sessionStore: new MemoryStore(),
});

async function turn(sessionId: string, input: string): Promise<string> {
  const handle = runtime.run({ sessionId, input, userId });
  return (await handle).text ?? '';
}

console.log(`PG working-memory smoke — phase ${phase}, userId=${userId}`);
if (phase === '1') {
  const a = await turn('pg-s1', 'Remember that my favorite color is teal.');
  console.log('assistant:', a);
  const saved = await store.loadBlock('user', userId, 'USER');
  console.log('USER block in Postgres:', JSON.stringify(saved?.content ?? null));
  if (!saved?.content?.toLowerCase().includes('teal')) {
    console.error('FAIL: USER block not persisted to Postgres');
    process.exit(1);
  }
  console.log('OK phase 1 — persisted to Postgres. Now run phase 2 in a fresh process.');
} else {
  const a = await turn('pg-s2', 'What is my favorite color?');
  console.log('assistant:', a);
  if (!a.toLowerCase().includes('teal')) {
    console.error('FAIL: phase 2 (fresh process) did not recall from Postgres');
    process.exit(1);
  }
  console.log('OK phase 2 — fresh process recalled "teal" from the Postgres-backed USER block.');
}
await sql.end();
