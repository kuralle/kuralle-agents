import { spawn, type Subprocess } from 'bun';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3877;
const BASE = `http://127.0.0.1:${PORT}`;
const counterFile = join(mkdtempSync(join(tmpdir(), 'kuralle-e2e-')), 'charges.txt');
const sessionId = `e2e-kill-resume-${Date.now()}`;

const flowDefinition = {
  name: 'refund',
  description: 'Collect an account id, charge the processing fee, reply with the verdict.',
  start: 'intake',
  nodes: [
    {
      kind: 'collect',
      id: 'intake',
      schema: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
        required: ['accountId'],
      },
      required: ['accountId'],
      ask: 'Ask the user for their account id.',
      assign: { 'state.accountId': 'accountId' },
      maxTurns: 6,
      next: { goto: 'charge' },
    },
    {
      kind: 'action',
      id: 'charge',
      tool: 'charge',
      args: { accountId: { path: 'state.accountId' } },
      bind: 'state.outcome',
      next: { goto: 'verdict' },
    },
    {
      kind: 'reply',
      id: 'verdict',
      response: { template: 'Account ${state.accountId}: ${state.outcome.verdict}.' },
      next: { end: 'done' },
    },
  ],
};

function startServer(): Subprocess {
  return spawn({
    cmd: ['bun', 'packages/hono-server/examples/e2e-kill-resume/server.ts'],
    env: {
      ...process.env,
      E2E_PORT: String(PORT),
      E2E_COUNTER_FILE: counterFile,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server never became ready');
}

async function chat(message: string): Promise<string> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok) throw new Error(`chat failed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { response: string };
  console.log(`[assistant] ${body.response}`);
  return body.response;
}

async function listRuns(): Promise<
  Array<{ runId: string; sessionId?: string; status?: string; kind?: string; flowName?: string }>
> {
  const res = await fetch(`${BASE}/e2e/runs`);
  return (await res.json()) as Array<{ runId: string; status?: string; kind?: string; flowName?: string }>;
}

function fail(message: string): never {
  console.error(`E2E FAIL: ${message}`);
  process.exit(1);
}

let server = startServer();
await waitReady();

const post = await fetch(`${BASE}/api/stored/flows`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ definition: flowDefinition, replace: true }),
});
if (!post.ok) {
  const text = await post.text();
  if (post.status === 409 && text.includes('already exists')) {
    console.log('[e2e] flow already stored (idempotent 409) — verifying active version via GET');
  } else {
    fail(`stored-flows POST returned ${post.status}: ${text}`);
  }
}
const active = await fetch(`${BASE}/api/stored/flows/refund`);
if (!active.ok) fail(`GET stored flow returned ${active.status}`);
console.log('[e2e] flow registered/active over HTTP');

await chat('Hi, I need a refund for my account please.');
const parked = await listRuns();
console.log('[e2e] runs after turn 1:', JSON.stringify(parked));
// Match THIS session only. A looser predicate matches a leftover run from an earlier
// execution against the same database, so the resume assertion below passes without the
// run under test ever surviving the kill.
const parkedRun = parked.find((r) => r.runId === sessionId || r.sessionId === sessionId);
if (!parkedRun) fail('no run found after turn 1');
const parkedRunId = parkedRun.runId;
if (existsSync(counterFile) && readFileSync(counterFile, 'utf8').trim() !== '') {
  fail('charge fired before the account id was collected');
}
console.log(`[e2e] parked run ${parkedRunId}; SIGKILL pid ${server.pid}`);

server.kill(9);
await server.exited;
console.log('[e2e] server killed mid-collect park; restarting');

server = startServer();
await waitReady();

const reply = await chat('My account id is acc-777.');
const runsAfter = await listRuns();
console.log('[e2e] runs after resume:', JSON.stringify(runsAfter));
const resumed = runsAfter.find((r) => r.runId === parkedRunId);
if (!resumed) fail(`run ${parkedRunId} vanished across the restart`);

const charges = existsSync(counterFile)
  ? readFileSync(counterFile, 'utf8').trim().split('\n').filter(Boolean)
  : [];
if (charges.length !== 1) fail(`expected exactly 1 charge, found ${charges.length}: ${JSON.stringify(charges)}`);
if (!charges[0]!.includes('acc-777')) fail(`charge recorded wrong account: ${charges[0]}`);
if (!reply.toLowerCase().includes('refund approved') && !reply.includes('acc-777')) {
  fail(`final reply does not carry the verdict: ${reply}`);
}

server.kill();
rmSync(counterFile, { force: true });
console.log('E2E PASS: flow registered over HTTP, parked mid-collect, survived SIGKILL, resumed the same run, charged exactly once.');
