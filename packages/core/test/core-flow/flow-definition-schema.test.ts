import { describe, expect, it } from 'bun:test';
import {
  FLOW_DEFINITION_NODE_KINDS,
  authoringPredicateSchema,
  flowDefinitionSchema,
  mappingConfigSchema,
  validateTemplateSyntax,
} from '../../src/flows/definition/index.js';

const startReply = {
  kind: 'reply' as const,
  id: 'greet',
  instructions: 'Hello ${input.name}',
  generate: true as const,
  next: { goto: 'ask' },
};

describe('flowDefinitionSchema', () => {
  it('accepts a conversational-core definition with each node kind', () => {
    const parsed = flowDefinitionSchema.safeParse({
      name: 'refund',
      description: 'Refund a payment',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      start: 'greet',
      nodes: [
        startReply,
        {
          kind: 'collect',
          id: 'ask',
          schema: { type: 'object', properties: { email: { type: 'string' } } },
          ask: 'What is your email?',
          assign: { 'state.email': 'email' },
          resolvers: [{ field: 'email', kind: 'jsonpath' }],
          next: { goto: 'charge' },
        },
        {
          kind: 'action',
          id: 'charge',
          tool: 'refund',
          args: {
            amount: { path: 'state.amount' },
            note: { template: 'Refund for ${input.name}' },
            dryRun: { value: false },
          },
          bind: 'state.receipt',
          approval: true,
          next: { goto: 'route' },
        },
        {
          kind: 'decide',
          id: 'route',
          choices: [{ id: 'ok', label: 'OK' }],
          routes: [
            {
              when: { op: 'eq', left: { path: 'state.status' }, right: { literal: 'ok' } },
              to: { end: 'done' },
            },
          ],
          otherwise: 'stay',
          confirmGate: {
            onConfirm: { end: 'confirmed' },
            onDecline: { escalate: 'human' },
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('enforces reply response template XOR generate: true', () => {
    const neither = flowDefinitionSchema.safeParse({
      name: 'x',
      description: '',
      start: 'a',
      nodes: [{ kind: 'reply', id: 'a', next: { end: 'done' } }],
    });
    const both = flowDefinitionSchema.safeParse({
      name: 'x',
      description: '',
      start: 'a',
      nodes: [{ kind: 'reply', id: 'a', generate: true, response: { template: 'hi' }, next: { end: 'done' } }],
    });
    const template = flowDefinitionSchema.safeParse({
      name: 'x',
      description: '',
      start: 'a',
      nodes: [{ kind: 'reply', id: 'a', response: { template: 'hi' }, next: { end: 'done' } }],
    });
    expect(neither.success).toBe(false);
    expect(both.success).toBe(false);
    expect(template.success).toBe(true);
  });

  it('rejects container node kinds outside the conversational core', () => {
    expect(FLOW_DEFINITION_NODE_KINDS).toEqual(['reply', 'collect', 'action', 'decide']);
    for (const kind of ['parallel', 'foreach', 'loop', 'sleep', 'sleepUntil']) {
      const parsed = flowDefinitionSchema.safeParse({
        name: 'x',
        description: '',
        start: 'a',
        nodes: [{ kind, id: 'a' }],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects MappingConfig encoded as a JSON string', () => {
    const asString = mappingConfigSchema.safeParse('{"amount":{"value":1}}');
    const asObject = mappingConfigSchema.safeParse({ amount: { value: 1 } });
    const mixedKeys = mappingConfigSchema.safeParse({ amount: { value: 1, path: 'state.x' } });
    expect(asString.success).toBe(false);
    expect(asObject.success).toBe(true);
    expect(mixedKeys.success).toBe(false);
  });

  it('accepts whenSource on a compiled route and rejects authoring nl in the canonical schema', () => {
    const withSource = flowDefinitionSchema.safeParse({
      name: 'refund',
      description: '',
      start: 'route',
      nodes: [
        {
          kind: 'decide',
          id: 'route',
          routes: [
            {
              when: { op: 'gt', left: { path: 'input.amount' }, right: { literal: 500 } },
              whenSource: 'the refund exceeds 500',
              to: { end: 'done' },
            },
          ],
        },
      ],
    });
    const withNl = flowDefinitionSchema.safeParse({
      name: 'refund',
      description: '',
      start: 'route',
      nodes: [
        {
          kind: 'decide',
          id: 'route',
          routes: [{ when: { nl: 'the refund exceeds 500' }, to: { end: 'done' } }],
        },
      ],
    });
    expect(withSource.success).toBe(true);
    expect(withNl.success).toBe(false);
    expect(authoringPredicateSchema.safeParse({ nl: 'the refund exceeds 500' }).success).toBe(true);
    expect(
      authoringPredicateSchema.safeParse({
        op: 'gt',
        left: { path: 'input.amount' },
        right: { literal: 500 },
      }).success,
    ).toBe(true);
  });
});

describe('validateTemplateSyntax', () => {
  it('flags mustache placeholders, empty ${}, and unknown roots', () => {
    expect(validateTemplateSyntax('Hello ${input.name}')).toEqual([]);
    expect(validateTemplateSyntax('Hello {{input.name}}').map((i) => i.code)).toEqual(['mustache_placeholder']);
    expect(validateTemplateSyntax('Hello ${}').map((i) => i.code)).toEqual(['empty_placeholder']);
    expect(validateTemplateSyntax('Hello ${initData.foo}').map((i) => i.code)).toEqual(['unknown_root']);
  });
});
