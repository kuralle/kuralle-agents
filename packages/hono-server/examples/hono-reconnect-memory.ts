/**
 * Live test: disconnect + reconnect to the same session over the hono server,
 * backed by Postgres (durable session history + durable working memory).
 *   bun examples/hono-reconnect-memory.ts
 * Requires OPENAI_API_KEY + reachable Postgres (PG_URL or default localhost db).
 */
import { SQL } from 'bun';
import { createOpenAI } from '@ai-sdk/openai';
import { defineAgent, createRuntime } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '@kuralle-agents/hono-server';
// postgres-store is not a hono-server dep; import its built dist directly for this smoke.
import { PostgresSessionStore, PostgresPersistentMemoryStore } from '../../postgres-store/dist/index.js';

const PG_URL = process.env.PG_URL ?? 'postgresql://localhost:5432/kuralle_wm_smoke';
const sql = new SQL(PG_URL);
const client = { async query(text: string, params?: unknown[]) { return { rows: (await sql.unsafe(text, (params as never[]) ?? [])) as unknown[] }; } } as never;

const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })('gpt-4o-mini');
const sessionId = `hono-recon-${Date.now()}`;
const userId = `u-${Date.now()}`;

const agent = defineAgent({
  id: 'recon-demo',
  model,
  instructions: 'You are a friendly assistant. Be concise.', // NEUTRAL — framework drives memory
  memory: { workingMemory: { store: new PostgresPersistentMemoryStore({ client }), autoLoad: [{ scope: 'user', key: 'USER' }] } },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'recon-demo',
  defaultModel: model,
  sessionStore: new PostgresSessionStore({ client }),       // durable session history
});

const app = createKuralleChatRouter({ runtime });
const server = Bun.serve({ port: 8799, fetch: app.fetch });

async function chat(message: string): Promise<string> {
  // separate fetch = new connection = "reconnect"
  const r = await fetch('http://localhost:8799/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, sessionId, userId }),
  });
  const j = (await r.json()) as { response?: string };
  return j.response ?? JSON.stringify(j);
}

console.log(`hono reconnect-memory test — sessionId=${sessionId} userId=${userId}`);
console.log('--- connection 1: store a preference ---');
console.log('assistant:', await chat('Remember that my favorite color is teal, and my name is Sam.'));

console.log('--- connection 2 (NEW request, same session): recall ---');
const recall = await chat('What is my favorite color, and what is my name?');
console.log('assistant:', recall);

// durability checks in Postgres
const sessRows = await sql.unsafe('SELECT id FROM kuralle_sessions WHERE id = $1', [sessionId]).catch(() => []);
const wm = await new PostgresPersistentMemoryStore({ client }).loadBlock('user', userId, 'USER');
console.log('session row in PG:', sessRows.length > 0 ? 'present' : 'MISSING');
console.log('USER working-memory block in PG:', JSON.stringify(wm?.content ?? null));

const ok = /teal/i.test(recall) && /sam/i.test(recall);
console.log(ok
  ? 'OK — reconnecting to the same session over hono recalled both facts (session + working memory persisted to Postgres).'
  : 'FAIL — recall did not contain the stored facts.');
server.stop();
await sql.end();
process.exit(ok ? 0 : 1);
