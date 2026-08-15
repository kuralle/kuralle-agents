import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { LanguageModel } from 'ai';
import {
  createRuntime,
  defineAgent,
  MemoryFlowDefinitionsStore,
  MemoryStore,
  type ChannelDriver,
  type FlowDefinition,
  type Policy,
  type StreamPart,
} from '@kuralle-agents/core';
import { createKuralleChatRouter, createStoredFlowsRouter } from '../src/index.ts';

const stubModel = {} as LanguageModel;

function sampleDefinition(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
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
    ...overrides,
  };
}

function denyWrites(): Policy {
  return {
    decide: (req) =>
      req.toolName === 'stored-flows:write'
        ? { kind: 'deny', reason: 'writes forbidden' }
        : { kind: 'allow' },
  };
}

function enterRefundDriver(): ChannelDriver {
  return {
    async runAgentTurn(node) {
      if ('enter_flow' in (node.tools ?? {})) {
        return {
          text: '',
          toolResults: [
            {
              name: 'enter_flow',
              args: { flowName: 'refund', reason: 'user asked' },
              result: { __enterFlow: true, flowName: 'refund' },
            },
          ],
          control: { type: 'enterFlow', flowName: 'refund' },
        };
      }
      return { text: 'no flow', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message' as const, input: '' };
    },
  };
}

function setup(opts?: { policy?: Policy; driver?: ChannelDriver }) {
  const agent = defineAgent({
    id: 'clerk',
    instructions: 'Help the user.',
    model: stubModel,
  });
  const store = new MemoryFlowDefinitionsStore();
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: stubModel,
    sessionStore: new MemoryStore(),
    flowDefinitionsStore: store,
    ...(opts?.driver ? { driver: opts.driver } : {}),
  });
  const stored = createStoredFlowsRouter({
    runtime,
    store,
    agentId: agent.id,
    storedFlowsPolicy: opts?.policy,
  });
  const app = new Hono();
  app.route('/', stored);
  app.route('/', createKuralleChatRouter({ runtime }));
  return { app, store, runtime, agentId: agent.id };
}

describe('stored-flows HTTP routes', () => {
  it('denies a write with 403 and leaves the store unchanged', async () => {
    const { app, store } = setup({ policy: denyWrites() });
    const before = await store.list();

    const response = await app.request('/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: sampleDefinition(),
        authorId: 'admin',
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('writes forbidden');
    expect(await store.list()).toEqual(before);
    expect(await store.getActive('refund')).toBeNull();
  });

  it('does not treat authorId as authorization when a policy denies the write', async () => {
    const { app, store } = setup({ policy: denyWrites() });

    const response = await app.request('/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: sampleDefinition(),
        authorId: 'admin',
      }),
    });

    expect(response.status).toBe(403);
    expect(await store.list()).toHaveLength(0);
  });

  it('returns 422 with exact issue codes for an invalid definition', async () => {
    const { app, store } = setup();

    const response = await app.request('/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: sampleDefinition({
          start: 'missing',
          nodes: [
            { kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } },
            { kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } },
          ],
        }),
      }),
    });

    expect(response.status).toBe(422);
    const issues = (await response.json()) as Array<{ code: string; path: string; repair?: unknown }>;
    expect(issues.map((issue) => issue.code).sort()).toEqual(['duplicate-node-id', 'missing-start'].sort());
    expect(issues.some((issue) => issue.code === 'missing-start' && issue.path === 'start')).toBe(true);
    expect(issues.some((issue) => issue.repair !== undefined)).toBe(true);
    expect(await store.list()).toHaveLength(0);
  });

  it('registers a valid bundle, lists it, and runs it through POST /api/chat', async () => {
    const { app, store } = setup({ driver: enterRefundDriver() });

    const created = await app.request('/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        definition: sampleDefinition(),
        dependencies: [
          sampleDefinition({
            name: 'helper',
            description: 'Helper',
            start: 'hi',
            nodes: [{ kind: 'reply', id: 'hi', response: { template: 'helper' }, next: { end: 'done' } }],
          }),
        ],
      }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { names: string[] };
    expect(createdBody.names).toEqual(['helper', 'refund']);
    expect(await store.getActive('refund')).not.toBeNull();
    expect(await store.getActive('helper')).not.toBeNull();

    const listed = await app.request('/api/stored/flows?status=active&name=refund');
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { flows: Array<{ name: string; status: string }> };
    expect(listedBody.flows).toHaveLength(1);
    expect(listedBody.flows[0]).toMatchObject({ name: 'refund', status: 'active' });

    const byName = await app.request('/api/stored/flows/refund');
    expect(byName.status).toBe(200);
    const detail = (await byName.json()) as {
      active: { name: string; digest: string } | null;
      versions: Array<{ name: string }>;
    };
    expect(detail.active?.name).toBe('refund');
    expect(detail.versions).toHaveLength(1);

    const chat = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'refund please', sessionId: 'stored-flows-exec' }),
    });
    expect(chat.status).toBe(200);
    const chatBody = (await chat.json()) as { response: string };
    expect(chatBody.response).toContain('Refund started');
  });

  it('DELETE archives the store row, unregisters the flow, and is idempotent', async () => {
    const { app, store } = setup();
    await app.request('/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: sampleDefinition() }),
    });
    expect(await store.getActive('refund')).not.toBeNull();

    const first = await app.request('/api/stored/flows/refund', { method: 'DELETE' });
    expect(first.status).toBe(200);
    expect(await store.getActive('refund')).toBeNull();
    const archived = await store.list({ name: 'refund', status: 'archived' });
    expect(archived).toHaveLength(1);

    const second = await app.request('/api/stored/flows/refund', { method: 'DELETE' });
    expect(second.status).toBe(200);
    expect((await second.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it('default-allows writes when no policy is configured', async () => {
    const { app, store } = setup();
    const response = await app.request('/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: sampleDefinition({ name: 'open' }) }),
    });
    expect(response.status).toBe(200);
    expect(await store.getActive('open')).not.toBeNull();
  });
});

describe('stored-flows SSE/chat stream parts after registration', () => {
  it('emits flow-enter for a posted definition on the ordinary chat path', async () => {
    const { runtime, app } = setup({ driver: enterRefundDriver() });
    await app.request('/api/stored/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition: sampleDefinition() }),
    });

    const parts: StreamPart[] = [];
    const handle = runtime.run({
      sessionId: 'stored-flows-parts',
      input: 'refund please',
      driver: enterRefundDriver(),
    });
    for await (const part of handle.events) parts.push(part);
    await handle;

    expect(parts.some((part) => part.type === 'flow-enter' && part.payload.flow === 'refund')).toBe(true);
    expect(parts.some((part) => part.type === 'flow-end' && part.payload.flow === 'refund')).toBe(true);
  });
});
