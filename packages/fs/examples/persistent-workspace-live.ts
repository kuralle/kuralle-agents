#!/usr/bin/env bun
/**
 * LIVE persistence smoke: a real model writes to a SqlFileSystem workspace in
 * "process 1", then a FRESH runtime + agent over the SAME SQLite DB reads it
 * back in "process 2". Proves the persistent workspace works end-to-end with
 * the live API AND survives a restart.
 *
 * Run:  KURALLE_EXAMPLE_PROVIDER=openai bun run packages/fs/examples/persistent-workspace-live.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createRuntime, defineAgent, createFsTool } from '@kuralle-agents/core';
import type { HarnessStreamPart, TurnHandle } from '@kuralle-agents/core';
import { sqlFileSystem, type SqlBackend } from '@kuralle-agents/fs';

function bunSqliteBackend(db: Database): SqlBackend {
  return {
    query: (sql, ...p) => db.query(sql).all(...p) as never,
    run: (sql, ...p) => {
      db.query(sql).run(...p);
    },
  };
}

async function resolveModel() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required.');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return { model: createOpenAI({ apiKey: key })(modelId), label: `openai:${modelId}` };
}

async function collect(handle: TurnHandle) {
  const parts: HarnessStreamPart[] = [];
  let text = '';
  for await (const part of handle.events) {
    parts.push(part);
    if (part.type === 'text-delta') text += part.delta;
  }
  await handle;
  return { parts, text };
}

function agentOver(fs: ReturnType<typeof sqlFileSystem>, model: unknown, role: string) {
  return defineAgent({
    id: `persist-${role}`,
    model: model as never,
    instructions:
      'You are a workspace assistant. Use the `workspace` tool for all file access: ' +
      "write with { op: 'write', path, content }, read with { op: 'read', path }. " +
      'Do exactly what the user asks and report the result.',
    tools: { workspace: createFsTool({ fs, readOnly: false }) },
    limits: { maxSteps: 6 },
  });
}

async function main() {
  const { model, label } = await resolveModel();
  console.log(`model: ${label}\n`);
  const dbPath = join(mkdtempSync(join(tmpdir(), 'kuralle-live-')), 'agent.db');

  // ── Process 1: the model WRITES a fact to the persistent workspace. ──
  const db1 = new Database(dbPath);
  const fs1 = sqlFileSystem(bunSqliteBackend(db1));
  const rt1 = createRuntime({ agents: [agentOver(fs1, model, 'writer')], defaultAgentId: 'persist-writer' });
  const w = await collect(rt1.run({
    input: "Save the user's favorite color, which is INDIGO, by writing the file /memory/color.md with exactly the content: INDIGO",
    sessionId: 'p1',
  }));
  const wrote = (w.parts.filter((p) => p.type === 'tool-call') as Array<{ toolName: string; args: { op?: string } }>)
    .some((c) => c.toolName === 'workspace' && c.args?.op === 'write');
  const onDisk = await fs1.readFile('/memory/color.md').catch(() => '');
  db1.close();
  console.log(`process 1: model called workspace write = ${wrote}; file on disk = ${JSON.stringify(onDisk)}`);

  // ── Process 2: fresh runtime + agent over the SAME db reads it back. ──
  const fs2 = sqlFileSystem(bunSqliteBackend(new Database(dbPath)));
  const rt2 = createRuntime({ agents: [agentOver(fs2, model, 'reader')], defaultAgentId: 'persist-reader' });
  const r = await collect(rt2.run({
    input: 'Read the file /memory/color.md using the workspace tool and tell me the favorite color it contains.',
    sessionId: 'p2',
  }));
  const readCall = (r.parts.filter((p) => p.type === 'tool-call') as Array<{ toolName: string; args: { op?: string } }>)
    .some((c) => c.toolName === 'workspace' && c.args?.op === 'read');
  console.log(`process 2: model called workspace read = ${readCall}`);
  console.log(`process 2 answer: ${r.text.replace(/\s+/g, ' ').trim()}\n`);

  const failures: string[] = [];
  if (!wrote) failures.push('process-1 model did not call workspace write');
  if (onDisk !== 'INDIGO') failures.push(`file not persisted correctly (got ${JSON.stringify(onDisk)})`);
  if (!readCall) failures.push('process-2 model did not call workspace read');
  if (!/indigo/i.test(r.text)) failures.push('process-2 answer did not contain the persisted color');

  if (failures.length) {
    console.error('LIVE PERSISTENCE FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('LIVE PERSISTENCE PASSED — process-1 model wrote to SqlFileSystem; process-2 model (fresh runtime, same DB) read it back over the live API.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
