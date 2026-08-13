import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import {
  createExtractionSubmitTool,
  getCollectData,
} from '../../src/flow/extraction.js';
import { resolveDeterministicSlots, valueHasProvenance } from '../../src/flow/slotResolution.js';
import { FLOW_INPUT_KEY, rehydrateFlow } from '../../src/flows/definition/index.js';
import { TraceRecorder } from '../../src/runtime/TraceRecorder.js';
import type { StreamPart } from '../../src/types/stream.js';
import type { ChannelDriver } from '../../src/types/channel.js';

const URGENCY = ['emergency', 'urgent', 'routine'] as const;

function spyDriver(opts: {
  onExtraction?: () => void;
  submit?: Record<string, unknown>;
  nodeId?: string;
}): ChannelDriver & { extractionCalls: number } {
  const nodeId = opts.nodeId ?? 'intake';
  const driver = {
    extractionCalls: 0,
    async runExtraction() {
      driver.extractionCalls += 1;
      opts.onExtraction?.();
      const result = opts.submit ?? {};
      return {
        text: '',
        toolResults: [
          {
            name: `submit_${nodeId}_data`,
            args: result,
            result,
          },
        ],
      };
    },
    async runAgentTurn() {
      return { text: '', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message' as const, input: 'next' };
    },
  };
  return driver;
}

async function runCollect(args: {
  node: ReturnType<typeof collect>;
  userText: string;
  driver: ChannelDriver;
  state?: Record<string, unknown>;
  parts?: StreamPart[];
  recorder?: TraceRecorder;
}) {
  const collectNode = args.node;
  const flow = defineFlow({
    name: 'tiered-collect',
    description: 'tiered slot resolution',
    start: collectNode,
    nodes: [collectNode],
    state: {
      input: (source) => ({ ...source }),
      output: (frame) => frame,
    },
  });
  const { session, runStore, runState } = await setupDurableHarness('tiered-sess', 'tiered-run');
  runState.messages = [{ role: 'user', content: args.userText }];
  runState.activeFlow = flow.name;
  runState.activeNode = collectNode.id;
  if (args.state) {
    Object.assign(runState.state, args.state);
  }
  args.recorder?.record({
    channel: 'internal',
    type: 'node-enter',
    payload: { nodeName: collectNode.id },
  });
  const emit = (part: StreamPart) => {
    args.parts?.push(part);
    args.recorder?.record(part);
  };
  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: {} as import('ai').LanguageModel,
    emit,
  });
  const result = await runFlow(flow, runState, args.driver, ctx);
  return { result, runState, collectNode };
}

function askText(parts: StreamPart[]): string {
  return parts
    .filter((p) => p.type === 'text-delta')
    .map((p) => p.payload.delta)
    .join('');
}

function submitShapeKeys(node: ReturnType<typeof collect>, missing: string[]): string[] {
  const tool = createExtractionSubmitTool(node, missing);
  const schema = tool.input as z.ZodObject<z.ZodRawShape> | undefined;
  return schema?.shape ? Object.keys(schema.shape).sort() : [];
}

describe('tier 0 deterministic resolvers', () => {
  it('enum_check matches exact and unambiguous prefix, never-guesses on two hits', () => {
    const node = collect({
      id: 'intake',
      schema: z.object({ urgency: z.enum(URGENCY) }),
      required: ['urgency'],
      resolvers: [{ field: 'urgency', kind: 'enum_check', values: [...URGENCY] }],
      onComplete: () => ({ end: 'done' }),
    });

    expect(
      resolveDeterministicSlots(node, {
        userText: 'This is URGENT please',
        state: {},
        missing: ['urgency'],
      }).resolved,
    ).toEqual({ urgency: 'urgent' });

    expect(
      resolveDeterministicSlots(node, {
        userText: 'emerg',
        state: {},
        missing: ['urgency'],
      }).resolved,
    ).toEqual({ urgency: 'emergency' });

    const ambiguous = resolveDeterministicSlots(node, {
      userText: 'urgent or emergency',
      state: {},
      missing: ['urgency'],
    });
    expect(ambiguous.resolved).toEqual({});
    expect(ambiguous.ambiguous).toEqual(['urgency']);
  });

  it('range takes a single in-range number and refuses two', () => {
    const node = collect({
      id: 'intake',
      schema: z.object({ partySize: z.number() }),
      required: ['partySize'],
      resolvers: [{ field: 'partySize', kind: 'range', min: 1, max: 20 }],
      onComplete: () => ({ end: 'done' }),
    });

    expect(
      resolveDeterministicSlots(node, {
        userText: 'party of 4',
        state: {},
        missing: ['partySize'],
      }).resolved,
    ).toEqual({ partySize: 4 });

    const ambiguous = resolveDeterministicSlots(node, {
      userText: 'either 4 or 8 people',
      state: {},
      missing: ['partySize'],
    });
    expect(ambiguous.resolved).toEqual({});
    expect(ambiguous.ambiguous).toEqual(['partySize']);
  });

  it('jsonpath reads input/state and skips empty', () => {
    const node = collect({
      id: 'intake',
      schema: z.object({ email: z.string() }),
      required: ['email'],
      resolvers: [{ field: 'email', kind: 'jsonpath', path: 'input.email' }],
      onComplete: () => ({ end: 'done' }),
    });

    expect(
      resolveDeterministicSlots(node, {
        userText: 'go',
        state: { [FLOW_INPUT_KEY]: { email: 'ada@example.com' } },
        missing: ['email'],
      }).resolved,
    ).toEqual({ email: 'ada@example.com' });

    expect(
      resolveDeterministicSlots(node, {
        userText: 'go',
        state: {},
        missing: ['email'],
      }).resolved,
    ).toEqual({});
  });
});

describe('tier 1 narrowed extraction schema', () => {
  it('submit tool advertises only the fields still missing this turn', () => {
    const node = collect({
      id: 'intake',
      schema: z.object({
        urgency: z.enum(URGENCY),
        partySize: z.number(),
        notes: z.string().optional(),
      }),
      required: ['urgency', 'partySize'],
      onComplete: () => ({ end: 'done' }),
    });
    expect(submitShapeKeys(node, ['partySize'])).toEqual(['partySize']);
    expect(submitShapeKeys(node, ['urgency', 'partySize'])).toEqual(['partySize', 'urgency']);
  });
});

describe('tier 2 provenance guard', () => {
  it('strings need a case-insensitive substring; numbers match 500 vs 500.0; booleans pass', () => {
    expect(valueHasProvenance('Ada', 'my name is ada')).toBe(true);
    expect(valueHasProvenance('Ada Lovelace', 'my cat is named Whiskers')).toBe(false);
    expect(valueHasProvenance(500, 'charge 500.0 please')).toBe(true);
    expect(valueHasProvenance(501, 'charge 500.0 please')).toBe(false);
    expect(valueHasProvenance(true, 'anything')).toBe(true);
  });
});

describe('tiered collect fixtures', () => {
  it('a fully-resolver-covered turn costs zero model calls and fills the fields', async () => {
    const driver = spyDriver({
      submit: { urgency: 'routine', partySize: 99 },
    });
    const node = collect({
      id: 'intake',
      schema: z.object({
        urgency: z.enum(URGENCY),
        partySize: z.number(),
        email: z.string().email(),
      }),
      required: ['urgency', 'partySize', 'email'],
      resolvers: [
        { field: 'urgency', kind: 'enum_check', values: [...URGENCY] },
        { field: 'partySize', kind: 'range', min: 1, max: 20 },
        { field: 'email', kind: 'jsonpath', path: 'input.email' },
      ],
      onComplete: () => ({ end: 'done' }),
    });
    const parts: StreamPart[] = [];
    const recorder = new TraceRecorder({ sessionId: 'tiered-sess', agentId: 'intake-agent' });
    const { result, runState } = await runCollect({
      node,
      userText: 'urgent, party of 4',
      driver,
      state: { [FLOW_INPUT_KEY]: { email: 'ada@example.com' } },
      parts,
      recorder,
    });

    expect(result.kind).toBe('ended');
    expect(driver.extractionCalls).toBe(0);
    expect(getCollectData(runState.state, 'intake')).toEqual({
      urgency: 'urgent',
      partySize: 4,
      email: 'ada@example.com',
    });

    const nodeSpan = recorder.finish({ text: '', toolResults: [] }).spans.find((span) => span.kind === 'node');
    expect(nodeSpan?.attributes.slotSources).toEqual({
      urgency: 'deterministic',
      partySize: 'deterministic',
      email: 'deterministic',
    });
  });

  it('drops a fabricated extracted string and re-asks naming the field', async () => {
    const driver = spyDriver({
      submit: { name: 'Ada Lovelace' },
      nodeId: 'name',
    });
    const node = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      onComplete: () => ({ end: 'done' }),
    });
    const parts: StreamPart[] = [];
    const { result, runState } = await runCollect({
      node,
      userText: 'my cat is named Whiskers',
      driver,
      parts,
    });

    expect(result.kind).toBe('awaitingUser');
    expect(getCollectData(runState.state, 'name').name).toBeUndefined();
    expect(askText(parts).toLowerCase()).toContain('name');
  });

  it('two enum matches leave the field unresolved and ask naming it', async () => {
    const driver = spyDriver({
      submit: { urgency: 'urgent' },
    });
    const node = collect({
      id: 'intake',
      schema: z.object({ urgency: z.enum(URGENCY) }),
      required: ['urgency'],
      resolvers: [{ field: 'urgency', kind: 'enum_check', values: [...URGENCY] }],
      onComplete: () => ({ end: 'done' }),
    });
    const parts: StreamPart[] = [];
    const { result, runState } = await runCollect({
      node,
      userText: 'urgent or emergency — not sure',
      driver,
      parts,
    });

    expect(result.kind).toBe('awaitingUser');
    expect(driver.extractionCalls).toBe(0);
    expect(getCollectData(runState.state, 'intake').urgency).toBeUndefined();
    expect(askText(parts).toLowerCase()).toContain('urgency');
  });

  it('rehydrate copies typed resolvers onto the live collect node', () => {
    const flow = rehydrateFlow(
      {
        name: 'intake',
        description: '',
        start: 'ask',
        nodes: [
          {
            kind: 'collect',
            id: 'ask',
            schema: {
              type: 'object',
              properties: { urgency: { type: 'string' } },
              required: ['urgency'],
            },
            resolvers: [{ field: 'urgency', kind: 'enum_check', values: ['urgent'] }],
            next: { end: 'done' },
          },
        ],
      },
      { tools: () => undefined },
    );
    const node = flow.nodes[0];
    expect(node?.kind).toBe('collect');
    if (node?.kind === 'collect') {
      expect(node.resolvers).toEqual([{ field: 'urgency', kind: 'enum_check', values: ['urgent'] }]);
    }
  });
});
