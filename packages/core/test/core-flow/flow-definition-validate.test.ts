import { describe, expect, it } from 'bun:test';
import {
  assertValidFlowDefinition,
  validateFlowDefinition,
  type FlowDefinition,
  type FlowNodeDefinition,
  type FlowRegistryIndex,
  type FlowValidationIssue,
  type Predicate,
} from '../../src/flows/definition/index.js';

const emailSchema = {
  type: 'object',
  properties: { email: { type: 'string' } },
  required: ['email'],
};

const amountSchema = {
  type: 'object',
  properties: { amount: { type: 'number' } },
  required: ['amount'],
};

function flow(overrides: Partial<FlowDefinition> & Pick<FlowDefinition, 'nodes' | 'start'>): FlowDefinition {
  return {
    name: 'test-flow',
    description: '',
    ...overrides,
  };
}

function codes(issues: FlowValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function issueAt(issues: FlowValidationIssue[], code: string, path: string): FlowValidationIssue {
  const found = issues.find((issue) => issue.code === code && issue.path === path);
  if (!found) {
    throw new Error(`expected ${code} at ${path}, got ${JSON.stringify(issues)}`);
  }
  return found;
}

describe('validateFlowDefinition structure', () => {
  it('flags duplicate-node-id at the second id path', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [
          { kind: 'reply', id: 'a', generate: true, next: { end: 'done' } },
          { kind: 'reply', id: 'a', generate: true, next: { end: 'done' } },
        ],
      }),
    );
    const issue = issueAt(issues, 'duplicate-node-id', 'nodes.1.id');
    expect(issue.message).toContain('a');
  });

  it('flags missing-start when start does not resolve', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'missing',
        nodes: [{ kind: 'reply', id: 'a', generate: true, next: { end: 'done' } }],
      }),
    );
    issueAt(issues, 'missing-start', 'start');
    expect(codes(issues)).not.toContain('unreachable-node');
  });

  it('flags unresolved-transition at the dotted goto path', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [
          {
            kind: 'decide',
            id: 'a',
            routes: [{ when: { op: 'truthy', value: { literal: true } }, to: { goto: 'nope' } }],
            otherwise: { end: 'done' },
          },
        ],
      }),
    );
    issueAt(issues, 'unresolved-transition', 'nodes.0.routes.0.to');
  });

  it('flags unreachable-node at the node path', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [
          { kind: 'reply', id: 'a', generate: true, next: { end: 'done' } },
          { kind: 'reply', id: 'orphan', generate: true, next: { end: 'done' } },
        ],
      }),
    );
    issueAt(issues, 'unreachable-node', 'nodes.1');
  });

  it('flags invalid-reply when both response and generate are present', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [
          {
            kind: 'reply',
            id: 'a',
            generate: true,
            response: { template: 'hi' },
            next: { end: 'done' },
          } as FlowNodeDefinition,
        ],
      }),
    );
    issueAt(issues, 'invalid-reply', 'nodes.0');
  });

  it('flags invalid-reply when neither response nor generate is present', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [{ kind: 'reply', id: 'a', next: { end: 'done' } } as FlowNodeDefinition],
      }),
    );
    issueAt(issues, 'invalid-reply', 'nodes.0');
  });
});

describe('validateFlowDefinition references', () => {
  const graph: FlowDefinition = flow({
    start: 'a',
    nodes: [
      {
        kind: 'action',
        id: 'a',
        tool: 'lookup',
        next: { handoff: 'writer' },
      },
      {
        kind: 'collect',
        id: 'b',
        schema: { type: 'object' },
        choices: [{ id: 'go', label: 'Go', flow: { flowId: 'child', cta: 'Open' } }],
        next: { end: 'done' },
      },
    ],
  });

  it('skips missing-reference when the kind is absent from the index', () => {
    expect(validateFlowDefinition(graph).filter((issue) => issue.code === 'missing-reference')).toEqual([]);
    expect(
      validateFlowDefinition(graph, { tools: { lookup: {} } }).filter((issue) => issue.code === 'missing-reference'),
    ).toEqual([]);
    expect(
      validateFlowDefinition(graph, { agents: { writer: {} } }).filter((issue) => issue.code === 'missing-reference'),
    ).toEqual([]);
    expect(
      validateFlowDefinition(graph, { flows: { child: {} } }).filter((issue) => issue.code === 'missing-reference'),
    ).toEqual([]);
  });

  it('flags missing-reference for tools, agents, and flows when those kinds are indexed', () => {
    const issues = validateFlowDefinition(graph, { tools: {}, agents: {}, flows: {} });
    issueAt(issues, 'missing-reference', 'nodes.0.tool');
    issueAt(issues, 'missing-reference', 'nodes.0.next');
    issueAt(issues, 'missing-reference', 'nodes.1.choices.0.flow.flowId');
  });

  it('resolves a tool by registration key or canonical id', () => {
    const index: FlowRegistryIndex = { tools: { 'http:lookup': { id: 'lookup' } } };
    const byKey = flow({
      start: 'a',
      nodes: [{ kind: 'action', id: 'a', tool: 'http:lookup', next: { end: 'done' } }],
    });
    const byId = flow({
      start: 'a',
      nodes: [{ kind: 'action', id: 'a', tool: 'lookup', next: { end: 'done' } }],
    });
    expect(validateFlowDefinition(byKey, index).filter((issue) => issue.code === 'missing-reference')).toEqual([]);
    expect(validateFlowDefinition(byId, index).filter((issue) => issue.code === 'missing-reference')).toEqual([]);
  });

  it('hints when a tool id is a registered agent', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [{ kind: 'action', id: 'a', tool: 'writer', next: { end: 'done' } }],
      }),
      { tools: {}, agents: { writer: {} } },
    );
    const issue = issueAt(issues, 'missing-reference', 'nodes.0.tool');
    expect(issue.message).toContain('registered AGENT, not a tool — use handoff');
  });
});

describe('validateFlowDefinition schema-flow and templates', () => {
  it('flags invalid-predicate-reference for unknown roots, missing paths, and later nodes', () => {
    const issues = validateFlowDefinition(
      flow({
        name: 'pred',
        description: '',
        inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
        start: 'ask',
        nodes: [
          {
            kind: 'collect',
            id: 'ask',
            schema: emailSchema,
            next: { goto: 'route' },
          },
          {
            kind: 'decide',
            id: 'route',
            routes: [
              {
                when: {
                  op: 'and',
                  args: [
                    { op: 'eq', left: { path: '$.status' }, right: { path: 'input.missing' } },
                    { op: 'exists', path: 'results.later.email' },
                  ],
                },
                to: { goto: 'later' },
              },
            ],
            otherwise: { end: 'done' },
          },
          {
            kind: 'collect',
            id: 'later',
            schema: emailSchema,
            next: { end: 'done' },
          },
        ],
      }),
    );
    issueAt(issues, 'invalid-predicate-reference', 'nodes.1.routes.0.when.args.0.left.path');
    issueAt(issues, 'invalid-predicate-reference', 'nodes.1.routes.0.when.args.0.right.path');
    issueAt(issues, 'invalid-predicate-reference', 'nodes.1.routes.0.when.args.1.path');
  });

  it('accepts predicate paths against input, preceding results, and extended state', () => {
    const issues = validateFlowDefinition(
      flow({
        inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
        start: 'ask',
        nodes: [
          {
            kind: 'collect',
            id: 'ask',
            schema: emailSchema,
            assign: { 'state.email': 'email' },
            next: { goto: 'route' },
          },
          {
            kind: 'decide',
            id: 'route',
            routes: [
              {
                when: {
                  op: 'and',
                  args: [
                    { op: 'eq', left: { path: 'input.status' }, right: { literal: 'open' } },
                    { op: 'exists', path: 'results.ask.email' },
                    { op: 'exists', path: 'state.email' },
                  ],
                },
                to: { end: 'ok' },
              },
            ],
            otherwise: { end: 'done' },
          },
        ],
      }),
    );
    expect(issues.filter((issue) => issue.code === 'invalid-predicate-reference')).toEqual([]);
  });

  it('flags incompatible-schema when action args cannot satisfy a known tool input', () => {
    const issues = validateFlowDefinition(
      flow({
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        start: 'charge',
        nodes: [
          {
            kind: 'action',
            id: 'charge',
            tool: 'refund',
            args: { name: { path: 'input.name' } },
            next: { end: 'done' },
          },
        ],
      }),
      { tools: { refund: { inputSchema: amountSchema } } },
    );
    issueAt(issues, 'incompatible-schema', 'nodes.0.args');
  });

  it('does not flag incompatible-schema when the tool input schema is unknown', () => {
    const issues = validateFlowDefinition(
      flow({
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
        start: 'charge',
        nodes: [
          {
            kind: 'action',
            id: 'charge',
            tool: 'refund',
            args: { name: { path: 'input.name' } },
            next: { end: 'done' },
          },
        ],
      }),
      { tools: { refund: {} } },
    );
    expect(codes(issues)).not.toContain('incompatible-schema');
  });

  it('flags invalid-template for the Handlebars trap with an explicit ${} hint', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [{ kind: 'reply', id: 'a', response: { template: 'Hello {{input.name}}' }, next: { end: 'done' } }],
      }),
    );
    const issue = issueAt(issues, 'invalid-template', 'nodes.0.response.template');
    expect(issue.message).toContain('${');
    expect(issue.message).toContain('{{');
  });

  it('flags invalid-template for empty placeholders and unknown roots', () => {
    const empty = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [{ kind: 'reply', id: 'a', response: { template: 'Hello ${}' }, next: { end: 'done' } }],
      }),
    );
    issueAt(empty, 'invalid-template', 'nodes.0.response.template');
    const unknown = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [{ kind: 'reply', id: 'a', response: { template: 'Hello ${initData.name}' }, next: { end: 'done' } }],
      }),
    );
    issueAt(unknown, 'invalid-template', 'nodes.0.response.template');
  });

  it('flags invalid-map-reference for a mapping path that is not preceding', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'greet',
        nodes: [
          { kind: 'reply', id: 'greet', generate: true, next: { goto: 'charge' } },
          {
            kind: 'action',
            id: 'charge',
            tool: 'refund',
            args: { email: { path: 'results.ask.email' } },
            next: { goto: 'ask' },
          },
          {
            kind: 'collect',
            id: 'ask',
            schema: emailSchema,
            next: { end: 'done' },
          },
        ],
      }),
    );
    issueAt(issues, 'invalid-map-reference', 'nodes.1.args.email.path');
  });

  it('flags predicate-too-deep for nesting beyond 32 and for more than 256 nodes', () => {
    let deep: Predicate = { op: 'exists', path: 'input.ok' };
    for (let i = 0; i < 33; i++) deep = { op: 'not', arg: deep };
    const deepIssues = validateFlowDefinition(
      flow({
        inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        start: 'a',
        nodes: [
          {
            kind: 'decide',
            id: 'a',
            routes: [{ when: deep, to: { end: 'done' } }],
            otherwise: { end: 'done' },
          },
        ],
      }),
    );
    issueAt(deepIssues, 'predicate-too-deep', 'nodes.0.routes.0.when');

    const leaves: Predicate[] = Array.from({ length: 256 }, () => ({ op: 'exists' as const, path: 'input.ok' }));
    const wide: Predicate = { op: 'and', args: leaves };
    const wideIssues = validateFlowDefinition(
      flow({
        inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        start: 'a',
        nodes: [
          {
            kind: 'decide',
            id: 'a',
            routes: [{ when: wide, to: { end: 'done' } }],
            otherwise: { end: 'done' },
          },
        ],
      }),
    );
    issueAt(wideIssues, 'predicate-too-deep', 'nodes.0.routes.0.when');
  });

  it('accepts a predicate at the depth cap of 32', () => {
    let atCap: Predicate = { op: 'exists', path: 'input.ok' };
    for (let i = 0; i < 31; i++) atCap = { op: 'not', arg: atCap };
    const issues = validateFlowDefinition(
      flow({
        inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        start: 'a',
        nodes: [
          {
            kind: 'decide',
            id: 'a',
            routes: [{ when: atCap, to: { end: 'done' } }],
            otherwise: { end: 'done' },
          },
        ],
      }),
    );
    expect(issues.filter((issue) => issue.code === 'predicate-too-deep')).toEqual([]);
  });
});

describe('validateFlowDefinition repair actions', () => {
  it('legalSources excludes incompatible preceding nodes and later nodes', () => {
    const issues = validateFlowDefinition(
      flow({
        inputSchema: amountSchema,
        start: 'greet',
        nodes: [
          { kind: 'reply', id: 'greet', generate: true, next: { goto: 'ask' } },
          {
            kind: 'collect',
            id: 'ask',
            schema: emailSchema,
            next: { goto: 'charge' },
          },
          {
            kind: 'action',
            id: 'charge',
            tool: 'refund',
            args: { email: { path: 'results.ask.email' } },
            next: { goto: 'thanks' },
          },
          { kind: 'reply', id: 'thanks', generate: true, next: { end: 'done' } },
        ],
      }),
      { tools: { refund: { inputSchema: amountSchema, outputSchema: { type: 'object' } } } },
    );
    const issue = issueAt(issues, 'incompatible-schema', 'nodes.2.args');
    expect(issue.repair).toBeDefined();
    const sources = issue.repair!.legalSources;
    expect(sources.some((source) => 'input' in source.source)).toBe(true);
    expect(sources.some((source) => 'node' in source.source && source.source.node === 'ask')).toBe(false);
    expect(sources.some((source) => 'node' in source.source && source.source.node === 'thanks')).toBe(false);
    expect(sources.every((source) => source.compatibility !== 'incompatible')).toBe(true);
  });
});

describe('assertValidFlowDefinition', () => {
  it('returns silently for a valid definition', () => {
    expect(() =>
      assertValidFlowDefinition(
        flow({
          start: 'a',
          nodes: [{ kind: 'reply', id: 'a', generate: true, next: { end: 'done' } }],
        }),
      ),
    ).not.toThrow();
  });

  it('throws one aggregate error listing every issue', () => {
    expect(() =>
      assertValidFlowDefinition(
        flow({
          name: 'wf-bad',
          start: 'missing',
          nodes: [{ kind: 'reply', id: 'a', generate: true, next: { goto: 'nope' } }],
        }),
      ),
    ).toThrow(
      /Flow definition "wf-bad" failed validation with \d+ issue\(s\):[\s\S]*\[missing-start\] start[\s\S]*\[unresolved-transition\] nodes\.0\.next/,
    );
  });
});

describe('validateFlowDefinition gates', () => {
  it('flags duplicate gate ids as invalid-gate', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [{ kind: 'reply', id: 'a', generate: true, next: { end: 'done' } }],
        gates: [
          {
            id: 'ok',
            kind: 'predicate',
            severity: 'blocking',
            when: { op: 'eq', left: { path: 'state.status' }, right: { literal: 'ok' } },
          },
          {
            id: 'ok',
            kind: 'predicate',
            severity: 'advisory',
            when: { op: 'eq', left: { path: 'state.status' }, right: { literal: 'ok' } },
          },
        ],
      }),
    );
    const issue = issueAt(issues, 'invalid-gate', 'gates.1.id');
    expect(issue.message).toContain('ok');
  });

  it('flags a judge input that names an unknown results node', () => {
    const issues = validateFlowDefinition(
      flow({
        start: 'a',
        nodes: [{ kind: 'reply', id: 'a', generate: true, next: { end: 'done' } }],
        gates: [
          {
            id: 'j',
            kind: 'judge',
            severity: 'blocking',
            inputs: ['results.missing.status'],
          },
        ],
      }),
    );
    expect(issues.some((issue) => issue.code === 'invalid-predicate-reference' && issue.path === 'gates.0.inputs.0')).toBe(
      true,
    );
  });
});
