import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import {
  compileNlPredicate,
  NL_PREDICATE_COMPILER_VERSION,
  type NlPredicateProvider,
} from '../../src/flows/authoring/compileNlPredicate.js';
import { compileAuthoringPredicates } from '../../src/flows/authoring/compileAuthoringPredicates.js';
import {
  evaluatePredicate,
  type Predicate,
  type PredicateContext,
} from '../../src/flows/definition/predicate.js';
import type { AuthoringFlowDefinition } from '../../src/flows/definition/authoring.js';
import { flowDefinitionSchema } from '../../src/flows/definition/schema.js';
import { MemoryFlowDefinitionsStore } from '../../src/flows/definition/stores/MemoryFlowDefinitionsStore.js';
import {
  LiveFlowCatalog,
} from '../../src/flows/liveFlowCatalog.js';
import {
  agentToolSurface,
  registerDynamicFlowBundle,
} from '../../src/flows/addDynamicFlows.js';
import { stubModel } from '../core-durable/helpers.js';

const KNOWN = [
  'input.amount',
  'input.flagged',
  'state.status',
  'results.collect.email',
  'results.charge',
] as const;

const gtAmount: Predicate = {
  op: 'gt',
  left: { path: 'input.amount' },
  right: { literal: 500 },
};
const eqStatus: Predicate = {
  op: 'eq',
  left: { path: 'state.status' },
  right: { literal: 'approved' },
};
const lteAmount: Predicate = {
  op: 'lte',
  left: { path: 'input.amount' },
  right: { literal: 100 },
};
const inStatus: Predicate = {
  op: 'in',
  value: { path: 'state.status' },
  set: ['open', 'pending'],
};
const notInStatus: Predicate = {
  op: 'notIn',
  value: { path: 'state.status' },
  set: ['closed', 'cancelled'],
};
const emailExists: Predicate = { op: 'exists', path: 'results.collect.email' };
const chargeMissing: Predicate = { op: 'notExists', path: 'results.charge' };
const andBoth: Predicate = { op: 'and', args: [gtAmount, eqStatus] };
const orEither: Predicate = {
  op: 'or',
  args: [
    { op: 'eq', left: { path: 'state.status' }, right: { literal: 'open' } },
    gtAmount,
  ],
};
const notFlagged: Predicate = {
  op: 'not',
  arg: { op: 'truthy', value: { path: 'input.flagged' } },
};

/** Fixture-recorded compiler outputs keyed by the NL condition. */
const GOLDEN: ReadonlyArray<{ nl: string; predicate: Predicate }> = [
  { nl: 'the refund exceeds 500', predicate: gtAmount },
  { nl: 'status is approved', predicate: eqStatus },
  { nl: 'amount is at most 100', predicate: lteAmount },
  { nl: 'status is one of open or pending', predicate: inStatus },
  { nl: 'status is not closed or cancelled', predicate: notInStatus },
  { nl: 'an email was collected', predicate: emailExists },
  { nl: 'receipt is missing', predicate: chargeMissing },
  { nl: 'refund exceeds 500 and status is approved', predicate: andBoth },
  { nl: 'status is open or the refund exceeds 500', predicate: orEither },
  { nl: 'the user is not flagged', predicate: notFlagged },
];

const EVAL_CTX: PredicateContext = {
  input: { amount: 750, flagged: false },
  state: { status: 'approved' },
  results: { collect: { email: 'a@b.c' } },
};

function scriptedProvider(
  outputs: ReadonlyMap<string, unknown>,
  spy: { calls: number },
): NlPredicateProvider {
  return {
    modelId: 'scripted-nl-compiler',
    async generatePredicate({ prompt }) {
      spy.calls += 1;
      const marker = 'Condition:\n';
      const idx = prompt.lastIndexOf(marker);
      const condition = idx === -1 ? prompt.trim() : prompt.slice(idx + marker.length).trim();
      if (!outputs.has(condition)) {
        throw new Error(`scripted provider has no fixture for ${JSON.stringify(condition)}`);
      }
      return outputs.get(condition);
    },
  };
}

function goldenProvider(spy: { calls: number }): NlPredicateProvider {
  return scriptedProvider(new Map(GOLDEN.map((entry) => [entry.nl, entry.predicate])), spy);
}

function nlFlow(name: string, nl: string): AuthoringFlowDefinition {
  return {
    name,
    description: 'NL refund gate',
    inputSchema: { type: 'object', properties: { amount: { type: 'number' }, flagged: { type: 'boolean' } } },
    start: 'route',
    nodes: [
      {
        kind: 'decide',
        id: 'route',
        routes: [{ when: { nl }, to: { end: 'refund' } }],
        otherwise: { end: 'done' },
      },
    ],
  };
}

function bundle(compiler: NlPredicateProvider, store?: MemoryFlowDefinitionsStore) {
  const agent = defineAgent({ id: 'clerk', model: stubModel });
  const tools = agentToolSurface(agent);
  return {
    catalog: new LiveFlowCatalog([]),
    tools: tools.lookup,
    toolIndex: tools.index,
    store,
    compiler,
  };
}

describe('compileNlPredicate golden corpus', () => {
  it('compiles each fixture-recorded NL condition to the expected predicate', async () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(8);
    const spy = { calls: 0 };
    const provider = goldenProvider(spy);
    for (const entry of GOLDEN) {
      const result = await compileNlPredicate(entry.nl, KNOWN, provider);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.predicate).toEqual(entry.predicate);
      expect(result.provenance.modelId).toBe('scripted-nl-compiler');
      expect(result.provenance.compilerVersion).toBe(NL_PREDICATE_COMPILER_VERSION);
      expect(result.provenance.promptHash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(spy.calls).toBe(GOLDEN.length);
  });

  it('evaluates compiled predicates with zero further provider calls', async () => {
    const spy = { calls: 0 };
    const provider = goldenProvider(spy);
    const compiled: Predicate[] = [];
    for (const entry of GOLDEN) {
      const result = await compileNlPredicate(entry.nl, KNOWN, provider);
      expect(result.ok).toBe(true);
      if (result.ok) compiled.push(result.predicate);
    }
    const callsAfterCompile = spy.calls;
    expect(evaluatePredicate(compiled[0]!, EVAL_CTX)).toBe(true);
    expect(evaluatePredicate(compiled[1]!, EVAL_CTX)).toBe(true);
    expect(evaluatePredicate(compiled[2]!, { ...EVAL_CTX, input: { amount: 100, flagged: false } })).toBe(true);
    expect(evaluatePredicate(compiled[3]!, { ...EVAL_CTX, state: { status: 'open' } })).toBe(true);
    expect(evaluatePredicate(compiled[4]!, { ...EVAL_CTX, state: { status: 'open' } })).toBe(true);
    expect(evaluatePredicate(compiled[5]!, EVAL_CTX)).toBe(true);
    expect(evaluatePredicate(compiled[6]!, EVAL_CTX)).toBe(true);
    expect(evaluatePredicate(compiled[7]!, EVAL_CTX)).toBe(true);
    expect(evaluatePredicate(compiled[8]!, EVAL_CTX)).toBe(true);
    expect(evaluatePredicate(compiled[9]!, EVAL_CTX)).toBe(true);
    expect(spy.calls).toBe(callsAfterCompile);
  });

  it('rejects a compiler result that invents an out-of-scope path', async () => {
    const spy = { calls: 0 };
    const provider = scriptedProvider(
      new Map([['the refund exceeds 500', { op: 'exists', path: 'invented.secret' }]]),
      spy,
    );
    const result = await compileNlPredicate('the refund exceeds 500', KNOWN, provider);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('nl-predicate-compile-failed');
    expect(result.issues[0]?.message).toMatch(/invented\.secret/);
  });
});

describe('NL predicate compilation at save', () => {
  it('replaces NL with a compiled predicate, keeps whenSource, and pins provenance', async () => {
    const spy = { calls: 0 };
    const store = new MemoryFlowDefinitionsStore();
    const provider = goldenProvider(spy);
    await registerDynamicFlowBundle({
      ...bundle(provider, store),
      defs: [nlFlow('refund-a', 'the refund exceeds 500')],
    });
    const version = await store.getActive('refund-a');
    expect(version).not.toBeNull();
    const route = version!.definition.nodes[0] as {
      kind: 'decide';
      routes: Array<{ when: Predicate; whenSource?: string }>;
    };
    expect(route.routes[0]?.when).toEqual(gtAmount);
    expect(route.routes[0]?.whenSource).toBe('the refund exceeds 500');
    expect(flowDefinitionSchema.safeParse(version!.definition).success).toBe(true);
    expect(version!.compilerModelId).toBe('scripted-nl-compiler');
    expect(version!.compilerVersion).toBe(NL_PREDICATE_COMPILER_VERSION);
    expect(version!.compilerPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(version!.definition.nodes[0]).not.toEqual(
      expect.objectContaining({ routes: [expect.objectContaining({ when: { nl: expect.any(String) } })] }),
    );
  });

  it('pins the same provenance across an identical re-save of the same NL', async () => {
    const spy = { calls: 0 };
    const store = new MemoryFlowDefinitionsStore();
    const provider = goldenProvider(spy);
    await registerDynamicFlowBundle({
      ...bundle(provider, store),
      defs: [nlFlow('refund-a', 'the refund exceeds 500')],
    });
    await registerDynamicFlowBundle({
      ...bundle(provider, store),
      defs: [nlFlow('refund-b', 'the refund exceeds 500')],
    });
    const a = await store.getActive('refund-a');
    const b = await store.getActive('refund-b');
    expect(a?.compilerModelId).toBe(b?.compilerModelId);
    expect(a?.compilerPromptHash).toBe(b?.compilerPromptHash);
    expect(a?.compilerVersion).toBe(b?.compilerVersion);
    expect(a?.compilerPromptHash).toBeTruthy();
  });

  it('fails the save and stores nothing when the compiler invents a path', async () => {
    const store = new MemoryFlowDefinitionsStore();
    const provider = scriptedProvider(
      new Map([['the refund exceeds 500', { op: 'exists', path: 'requestContext.inventedSecret' }]]),
      { calls: 0 },
    );
    await expect(
      registerDynamicFlowBundle({
        ...bundle(provider, store),
        defs: [nlFlow('refund-bad', 'the refund exceeds 500')],
      }),
    ).rejects.toThrow(/failed validation/);
    expect(await store.list()).toEqual([]);
  });

  it('fails the whole bundle when one NL condition cannot compile', async () => {
    const store = new MemoryFlowDefinitionsStore();
    const provider = scriptedProvider(
      new Map([['the refund exceeds 500', gtAmount]]),
      { calls: 0 },
    );
    await expect(
      registerDynamicFlowBundle({
        ...bundle(provider, store),
        defs: [
          nlFlow('refund-ok', 'the refund exceeds 500'),
          nlFlow('refund-missing', 'this condition has no fixture'),
        ],
      }),
    ).rejects.toThrow(/failed validation/);
    expect(await store.list()).toEqual([]);
  });

  it('does not call the provider when evaluating a stored compiled predicate', async () => {
    const spy = { calls: 0 };
    const store = new MemoryFlowDefinitionsStore();
    const provider = goldenProvider(spy);
    await registerDynamicFlowBundle({
      ...bundle(provider, store),
      defs: [nlFlow('refund-a', 'the refund exceeds 500')],
    });
    const callsAfterSave = spy.calls;
    const version = await store.getActive('refund-a');
    const when = (version!.definition.nodes[0] as { routes: Array<{ when: Predicate }> }).routes[0]!.when;
    expect(evaluatePredicate(when, EVAL_CTX)).toBe(true);
    expect(spy.calls).toBe(callsAfterSave);
  });
});

describe('compileAuthoringPredicates', () => {
  it('leaves already-compiled predicates untouched', async () => {
    const spy = { calls: 0 };
    const result = await compileAuthoringPredicates(
      {
        name: 'already',
        description: '',
        start: 'route',
        nodes: [
          {
            kind: 'decide',
            id: 'route',
            routes: [{ when: gtAmount, to: { end: 'done' } }],
          },
        ],
      },
      goldenProvider(spy),
    );
    expect(result.issues).toEqual([]);
    expect(result.compiledCount).toBe(0);
    expect(spy.calls).toBe(0);
    expect(result.provenance).toBeUndefined();
  });
});
