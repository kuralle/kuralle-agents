import { describe, expect, it } from 'bun:test';
import { action, collect, decide, defineFlow, reply } from '../../src/types/flow.js';
import type { FlowDefinition, FlowNodeDefinition } from '../../src/flows/definition/index.js';
import {
  FLOW_INPUT_KEY,
  FLOW_RESULTS_KEY,
  rehydrateFlow,
  renderScopeTemplate,
  resolveMapping,
  resolveScopePath,
  toStorableFlow,
} from '../../src/flows/definition/index.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { defineTool } from '../../src/types/effectTool.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import type { ActionContext } from '../../src/types/run-context.js';
import type { StreamPart } from '../../src/types/stream.js';

const lookup = defineTool({
  name: 'lookup_account',
  description: 'Look up an account by email',
  execute: async (args: unknown) => ({
    status: 'ok',
    id: 'acc-1',
    email: (args as { email?: string }).email,
  }),
});

const notify = defineTool({
  name: 'notify_ops',
  description: 'Notify ops',
  execute: async () => ({ sent: true }),
});

const tools = { lookup_account: lookup, notify_ops: notify };

function deps(extra?: { live?: boolean }) {
  const live = extra?.live ?? true;
  return {
    tools: (id: string) => (live ? tools[id as keyof typeof tools] : undefined),
  };
}

function corpus(): FlowDefinition[] {
  const replyTemplate: FlowNodeDefinition = {
    kind: 'reply',
    id: 'greet',
    instructions: 'Hello ${input.name}',
    response: { template: 'Hi ${input.name}' },
    next: { goto: 'ask' },
  };
  const collectNode: FlowNodeDefinition = {
    kind: 'collect',
    id: 'ask',
    schema: {
      type: 'object',
      properties: { email: { type: 'string' }, amount: { type: 'number' } },
      required: ['email', 'amount'],
    },
    ask: 'What is your email?',
    instructions: 'Collect email and amount',
    assign: { 'state.email': 'email', 'state.amount': 'amount' },
    resolvers: [{ field: 'email', kind: 'jsonpath' }],
    required: ['email', 'amount'],
    maxTurns: 4,
    choices: [{ id: 'skip', label: 'Skip' }],
    next: { goto: 'charge' },
  };
  const actionNode: FlowNodeDefinition = {
    kind: 'action',
    id: 'charge',
    tool: 'lookup_account',
    args: {
      email: { path: 'state.email' },
      note: { template: 'Refund for ${input.name}' },
      dryRun: { value: false },
    },
    bind: 'state.account',
    approval: true,
    next: { goto: 'route' },
  };
  const decideRoutes: FlowNodeDefinition = {
    kind: 'decide',
    id: 'route',
    instructions: 'Route the refund',
    schema: { type: 'object', properties: { choice: { type: 'string' } } },
    choices: [{ id: 'ok', label: 'OK' }],
    routes: [
      {
        when: { op: 'eq', left: { path: 'results.charge.status' }, right: { literal: 'ok' } },
        to: { end: 'done' },
      },
      {
        when: { op: 'eq', left: { path: 'results.charge.status' }, right: { literal: 'hold' } },
        to: { escalate: 'human' },
      },
    ],
    otherwise: 'stay',
    confirmGate: {
      onConfirm: { end: 'confirmed' },
      onDecline: { handoff: 'writer', reason: 'declined' },
      onAmbiguous: { goto: 'ask', data: { retry: true } },
    },
  };
  const generateReply: FlowNodeDefinition = {
    kind: 'reply',
    id: 'bye',
    generate: true,
    next: { end: 'completed' },
  };

  return [
    {
      name: 'full-dialect',
      description: 'covers every node kind, arm, and transition form',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      outputSchema: { type: 'object' },
      start: 'greet',
      nodes: [replyTemplate, collectNode, actionNode, decideRoutes],
    },
    {
      name: 'generate-reply',
      description: 'generate arm',
      start: 'bye',
      nodes: [generateReply],
    },
    {
      name: 'action-routes',
      description: 'action routes and stay',
      start: 'charge',
      nodes: [
        {
          kind: 'action',
          id: 'charge',
          tool: 'notify_ops',
          routes: [
            {
              when: { op: 'truthy', value: { literal: true } },
              to: { goto: 'done' },
            },
          ],
        },
        {
          kind: 'reply',
          id: 'done',
          response: { template: 'ok' },
          next: { end: 'done' },
        },
      ],
    },
  ];
}

describe('renderScopeTemplate', () => {
  const scope = {
    input: { name: 'Ada', count: 2, ok: true },
    state: { nested: { n: 1 }, missing: null },
    results: { lookup: { id: 'acc-1', tags: ['a', 'b'] } },
    requestContext: { tenant: 'acme' },
  };

  it('renders primitives via String, objects via JSON.stringify, null as empty', () => {
    expect(renderScopeTemplate('${input.name}', scope)).toBe('Ada');
    expect(renderScopeTemplate('${input.count}', scope)).toBe('2');
    expect(renderScopeTemplate('${input.ok}', scope)).toBe('true');
    expect(renderScopeTemplate('${state.missing}', scope)).toBe('');
    expect(renderScopeTemplate('${state.absent}', scope)).toBe('');
    expect(renderScopeTemplate('${results.lookup.tags}', scope)).toBe('["a","b"]');
    expect(renderScopeTemplate('${requestContext.tenant}', scope)).toBe('acme');
  });

  it('throws naming the placeholder on circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => renderScopeTemplate('x ${state.loop} y', { state: { loop: circular } })).toThrow(
      /Circular value at placeholder \$\{state\.loop\}/,
    );
  });

  it('throws on unknown roots', () => {
    expect(() => renderScopeTemplate('${foo.bar}', scope)).toThrow(/Unknown path root "foo"/);
  });
});

describe('resolveMapping', () => {
  it('resolves value, template, and path sources', () => {
    const scope = {
      input: { name: 'Ada' },
      state: { email: 'ada@example.com' },
      results: {},
    };
    expect(
      resolveMapping(
        {
          email: { path: 'state.email' },
          note: { template: 'Hi ${input.name}' },
          dryRun: { value: false },
        },
        scope,
      ),
    ).toEqual({
      email: 'ada@example.com',
      note: 'Hi Ada',
      dryRun: false,
    });
  });

  it('resolveScopePath returns undefined for missing paths', () => {
    expect(resolveScopePath('state.missing', { state: {} })).toBeUndefined();
  });
});

describe('toStorableFlow(rehydrateFlow(def)) round-trip', () => {
  it('deep-equals the original definition for the dialect corpus', () => {
    for (const def of corpus()) {
      const flow = rehydrateFlow(def, deps());
      expect(flow.origin).toBe('definition');
      expect(toStorableFlow(flow)).toEqual(def);
    }
  });
});

describe('toStorableFlow on code flows', () => {
  it('throws on a start thunk naming the declarative replacement', () => {
    const node = reply({ id: 'a', instructions: 'hi', next: () => ({ end: 'done' }) });
    const flow = defineFlow({
      name: 'thunk',
      description: '',
      start: () => node,
      nodes: [node],
    });
    expect(() => toStorableFlow(flow)).toThrow(/Flow\.start is a thunk/);
  });

  it('throws on reply response/next/instructions functions', () => {
    const node = reply({
      id: 'a',
      instructions: 'hi',
      response: () => 'hello',
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'reply-fn', description: '', start: node, nodes: [node] });
    expect(() => toStorableFlow(flow)).toThrow(/response/);
  });

  it('throws on collect onComplete naming next + assign', () => {
    const node = collect({
      id: 'a',
      schema: { '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) } },
      onComplete: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'collect-fn', description: '', start: node, nodes: [node] });
    expect(() => toStorableFlow(flow)).toThrow(/onComplete/);
  });

  it('throws on action run naming tool/args/bind', () => {
    const node = action({ id: 'a', run: () => ({ end: 'done' }) });
    const flow = defineFlow({ name: 'action-fn', description: '', start: node, nodes: [node] });
    expect(() => toStorableFlow(flow)).toThrow(/run/);
  });

  it('throws on decide decide() naming routes + otherwise', () => {
    const node = decide({
      id: 'a',
      instructions: 'pick',
      schema: { '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) } },
      decide: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'decide-fn', description: '', start: node, nodes: [node] });
    expect(() => toStorableFlow(flow)).toThrow(/decide/);
  });
});

describe('unknown toolId authorization', () => {
  const def: FlowDefinition = {
    name: 'tool-auth',
    description: '',
    start: 'go',
    nodes: [
      { kind: 'action', id: 'go', tool: 'not_registered', next: { end: 'done' } },
    ],
  };

  it('fails rehydration when deps does not return the tool', () => {
    expect(() => rehydrateFlow(def, { tools: () => undefined })).toThrow(/Unknown tool "not_registered"/);
  });

  it('fails closed at run time if the deps lookup later returns undefined', async () => {
    let live = true;
    const flow = rehydrateFlow(
      {
        name: 'runtime-auth',
        description: '',
        start: 'go',
        nodes: [
          { kind: 'action', id: 'go', tool: 'lookup_account', next: { end: 'done' } },
        ],
      },
      { tools: (id) => (live ? tools[id as keyof typeof tools] : undefined) },
    );
    live = false;
    const actionNode = flow.nodes[0];
    if (actionNode?.kind !== 'action') throw new Error('expected action');
    const ctx: ActionContext = {
      tool: async () => {
        throw new Error('tool() should not be reached');
      },
      approve: async () => ({ approved: true }),
      signal: async () => {
        throw new Error('signal() should not be reached');
      },
      now: async () => 0,
      uuid: async () => 'test-uuid',
      emit: () => {},
      getSkill: () => {
        throw new Error('getSkill() should not be reached');
      },
    };
    await expect(actionNode.run({}, ctx)).rejects.toThrow(/Unknown tool "lookup_account"/);
  });
});

describe('rehydrated closures', () => {
  it('evaluates decide routes first-match then otherwise', () => {
    const flow = rehydrateFlow(
      {
        name: 'routes',
        description: '',
        inputSchema: { type: 'object', properties: { kind: { type: 'string' } } },
        start: 'd',
        nodes: [
          {
            kind: 'decide',
            id: 'd',
            routes: [
              {
                when: { op: 'eq', left: { path: 'input.kind' }, right: { literal: 'a' } },
                to: { end: 'a' },
              },
              {
                when: { op: 'eq', left: { path: 'input.kind' }, right: { literal: 'b' } },
                to: { escalate: 'human' },
              },
            ],
            otherwise: { end: 'other' },
          },
        ],
      },
      deps(),
    );
    const node = flow.nodes[0];
    if (node?.kind !== 'decide' || !node.decide) throw new Error('expected decide');
    expect(node.decide({}, { [FLOW_INPUT_KEY]: { kind: 'a' } })).toEqual({ end: 'a' });
    expect(node.decide({}, { [FLOW_INPUT_KEY]: { kind: 'b' } })).toEqual({ escalate: 'human' });
    expect(node.decide({}, { [FLOW_INPUT_KEY]: { kind: 'z' } })).toEqual({ end: 'other' });
  });

  it('writes collect assign paths and records results.<nodeId>', async () => {
    const flow = rehydrateFlow(
      {
        name: 'assign',
        description: '',
        start: 'c',
        nodes: [
          {
            kind: 'collect',
            id: 'c',
            schema: {
              type: 'object',
              properties: { email: { type: 'string' } },
              required: ['email'],
            },
            assign: { 'state.email': 'email' },
            next: { end: 'done' },
          },
        ],
      },
      deps(),
    );
    const node = flow.nodes[0];
    if (node?.kind !== 'collect') throw new Error('expected collect');
    const state: Record<string, unknown> = { [FLOW_RESULTS_KEY]: {} };
    const transition = await node.onComplete({ email: 'a@b.com' }, state);
    expect(state.email).toBe('a@b.com');
    expect((state[FLOW_RESULTS_KEY] as Record<string, unknown>).c).toEqual({ email: 'a@b.com' });
    expect(transition).toEqual({ end: 'done' });
    expect(node.schema).toMatchObject({ validated: false });
  });
});

describe('rehydrated flow through runFlow', () => {
  it('runs collect → action → decide → template reply without a model on template/action', async () => {
    const def: FlowDefinition = {
      name: 'eligibility',
      description: 'collect then lookup then route',
      start: 'intake',
      nodes: [
        {
          kind: 'collect',
          id: 'intake',
          schema: {
            type: 'object',
            properties: { email: { type: 'string' }, amount: { type: 'number' } },
            required: ['email', 'amount'],
          },
          required: ['email', 'amount'],
          assign: { 'state.email': 'email', 'state.amount': 'amount' },
          next: { goto: 'lookup' },
        },
        {
          kind: 'action',
          id: 'lookup',
          tool: 'lookup_account',
          args: { email: { path: 'state.email' } },
          bind: 'state.account',
          next: { goto: 'route' },
        },
        {
          kind: 'decide',
          id: 'route',
          routes: [
            {
              when: { op: 'eq', left: { path: 'results.lookup.status' }, right: { literal: 'ok' } },
              to: { goto: 'ok' },
            },
          ],
          otherwise: { goto: 'blocked' },
        },
        {
          kind: 'reply',
          id: 'ok',
          response: { template: 'Account ${state.account.id} is eligible for ${state.amount}.' },
          next: { end: 'eligible' },
        },
        {
          kind: 'reply',
          id: 'blocked',
          response: { template: 'Not eligible.' },
          next: { end: 'ineligible' },
        },
      ],
    };

    const flow = rehydrateFlow(def, deps());
    const driver = {
      async runAgentTurn() {
        throw new Error('template reply must not call the model');
      },
      async runStructured() {
        return {};
      },
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_intake_data',
              args: { email: 'ada@example.com', amount: 40 },
              result: { email: 'ada@example.com', amount: 40 },
            },
          ],
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'ada@example.com 40' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('rehydrate-sess', 'rehydrate-run');
    runState.messages = [{ role: 'user', content: 'ada@example.com wants 40' }];
    const parts: StreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => parts.push(part),
    });

    const result = await runFlow(flow, runState, driver, ctx);
    expect(result).toEqual({ kind: 'ended', reason: 'eligible' });
    const text = parts
      .filter((part): part is Extract<StreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
      .map((part) => part.payload.delta)
      .join('');
    expect(text).toContain('Account acc-1 is eligible for 40.');
    expect(runState.flowFrame).toBeUndefined();
  });
});
