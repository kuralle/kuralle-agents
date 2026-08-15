import { describe, expect, it } from 'bun:test';
import {
  createRuntime,
  defineAgent,
  MemoryFlowDefinitionsStore,
  MemoryStore,
  type FlowDefinition,
  type Policy,
} from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { dispatchStoredFlowsRequest } from '../storedFlowsHttp.ts';

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

function setup(policy?: Policy) {
  const agent = defineAgent({ id: 'clerk', instructions: 'Help.', model: stubModel });
  const store = new MemoryFlowDefinitionsStore();
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: stubModel,
    sessionStore: new MemoryStore(),
    flowDefinitionsStore: store,
  });
  let mutated = 0;
  const handle = (request: Request) =>
    dispatchStoredFlowsRequest({
      request,
      store,
      runtimeForWrite: async () => ({ runtime, agentId: agent.id }),
      storedFlowsPolicy: policy,
      onMutated: () => {
        mutated += 1;
      },
    });
  return { store, handle, mutated: () => mutated };
}

describe('cf-agent stored-flows HTTP dispatcher', () => {
  it('denies a write with 403 and leaves the store unchanged', async () => {
    const { store, handle, mutated } = setup(denyWrites());
    const response = await handle(
      new Request('http://do/api/stored/flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: sampleDefinition(), authorId: 'admin' }),
      }),
    );
    expect(response?.status).toBe(403);
    expect(await store.list()).toHaveLength(0);
    expect(mutated()).toBe(0);
  });

  it('returns 422 with missing-start for an invalid definition', async () => {
    const { store, handle } = setup();
    const response = await handle(
      new Request('http://do/api/stored/flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          definition: sampleDefinition({
            start: 'missing',
            nodes: [{ kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } }],
          }),
        }),
      }),
    );
    expect(response?.status).toBe(422);
    const issues = (await response!.json()) as Array<{ code: string }>;
    expect(issues.map((issue) => issue.code)).toContain('missing-start');
    expect(await store.list()).toHaveLength(0);
  });

  it('registers, lists, deletes idempotently, and bumps onMutated only on success', async () => {
    const { store, handle, mutated } = setup();
    const created = await handle(
      new Request('http://do/api/stored/flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: sampleDefinition() }),
      }),
    );
    expect(created?.status).toBe(200);
    expect(mutated()).toBe(1);
    expect(await store.getActive('refund')).not.toBeNull();

    const listed = await handle(new Request('http://do/api/stored/flows?status=active&name=refund'));
    const listedBody = (await listed!.json()) as { flows: Array<{ name: string }> };
    expect(listedBody.flows).toHaveLength(1);

    const first = await handle(new Request('http://do/api/stored/flows/refund', { method: 'DELETE' }));
    expect(first?.status).toBe(200);
    expect(mutated()).toBe(2);
    const second = await handle(new Request('http://do/api/stored/flows/refund', { method: 'DELETE' }));
    expect(second?.status).toBe(200);
    expect(mutated()).toBe(3);
  });
});
