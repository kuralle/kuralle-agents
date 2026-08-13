import { env } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { TestStoredFlowsAgent, TestThreadStoredFlowsAgent } from './cf-agent-worker.js';

interface StoredFlowsEnv {
  TEST_STORED_FLOWS_AGENT: DurableObjectNamespace<TestStoredFlowsAgent>;
  TEST_THREAD_STORED_FLOWS_AGENT: DurableObjectNamespace<TestThreadStoredFlowsAgent>;
}

const definition = {
  name: 'refund',
  description: 'Refund a payment',
  start: 'say',
  nodes: [
    {
      kind: 'reply',
      id: 'say',
      response: { template: 'Refund started' },
      next: { end: 'done' },
    },
  ],
};

describe('stored-flows HTTP surface (workerd)', () => {
  it('registers, lists, and deletes a definition; invalid bodies are 422; denied writes are 403 with no store mutation', async () => {
    const bindings = env as unknown as StoredFlowsEnv;
    const stub = await getAgentByName(bindings.TEST_STORED_FLOWS_AGENT, 'stored-flows-ok');

    const invalid = await stub.fetch('http://do/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: { ...definition, start: 'missing' },
      }),
    });
    expect(invalid.status).toBe(422);
    const issues = (await invalid.json()) as Array<{ code: string }>;
    expect(issues.some((issue) => issue.code === 'missing-start')).toBe(true);

    const created = await stub.fetch('http://do/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { names: string[] };
    expect(createdBody.names).toEqual(['refund']);

    const listed = await stub.fetch('http://do/api/stored/flows?status=active');
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { flows: Array<{ name: string }> };
    expect(listedBody.flows.map((row) => row.name)).toEqual(['refund']);

    const deleted = await stub.fetch('http://do/api/stored/flows/refund', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const deletedAgain = await stub.fetch('http://do/api/stored/flows/refund', { method: 'DELETE' });
    expect(deletedAgain.status).toBe(200);

    const deny = await getAgentByName(bindings.TEST_STORED_FLOWS_AGENT, 'deny-write-stored-flows');
    const forbidden = await deny.fetch('http://do/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition, authorId: 'admin' }),
    });
    expect(forbidden.status).toBe(403);
    const empty = await deny.fetch('http://do/api/stored/flows');
    const emptyBody = (await empty.json()) as { flows: unknown[] };
    expect(emptyBody.flows).toEqual([]);
  });

  it('bumps the thread pin-key cache generation so the next bind is a miss', async () => {
    const bindings = env as unknown as StoredFlowsEnv;
    const stub = await getAgentByName(bindings.TEST_THREAD_STORED_FLOWS_AGENT, 'thread-stored-flows');

    const initialized = await stub.fetch('http://do/_kuralle/initialize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenantId: 'tenant-a',
        threadId: 'thread-a',
        agentEntityId: 'support',
        environment: 'production',
      }),
    });
    expect(initialized.status).toBe(200);

    const first = await stub.fetch('http://do/_test/bind');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ binds: 1 });

    const cached = await stub.fetch('http://do/_test/bind');
    expect(await cached.json()).toEqual({ binds: 1 });

    const written = await stub.fetch('http://do/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition }),
    });
    expect(written.status).toBe(200);

    const rebound = await stub.fetch('http://do/_test/bind');
    expect(await rebound.json()).toEqual({ binds: 2 });
  });
});
