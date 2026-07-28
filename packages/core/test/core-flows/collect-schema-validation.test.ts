import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect } from '../../src/authoring/nodes.js';
import {
  invalidCollectFields,
  projectCollectData,
  schemaSatisfied,
} from '../../src/flow/extraction.js';
import type { StandardSchemaV1 } from '../../src/types/standard-schema.js';

/**
 * Collect completion used to be presence-only: any non-empty value passed. The schema was
 * used to derive key names and to build the partial submit tool, but its constraints were
 * never checked against a collected value — so a model that invented an enum member
 * completed the node and the flow acted on it.
 */
const node = collect({
  id: 'intake',
  schema: z.object({
    unitId: z.string(),
    urgency: z.enum(['emergency', 'urgent', 'routine']),
    contactEmail: z.string().email().optional(),
  }),
  required: ['unitId', 'urgency'],
  instructions: () => 'Extract.',
  onComplete: () => ({ end: 'ok' }),
});

const stateWith = (data: Record<string, unknown>) => ({ __collect_intake: data });

describe('collect completion validates against the schema', () => {
  it('rejects an enum value the model invented', async () => {
    const state = stateWith({ unitId: 'A-101', urgency: 'high' });
    expect(await invalidCollectFields(node, { unitId: 'A-101', urgency: 'high' })).toContain('urgency');
    expect(await schemaSatisfied(node, state)).toBe(false);
  });

  it('accepts a valid value', async () => {
    const state = stateWith({ unitId: 'A-101', urgency: 'urgent' });
    expect(await schemaSatisfied(node, state)).toBe(true);
  });

  it('rejects a malformed optional field that was supplied', async () => {
    const data = { unitId: 'A-101', urgency: 'routine', contactEmail: 'not-an-email' };
    expect(await invalidCollectFields(node, data)).toContain('contactEmail');
    expect(await schemaSatisfied(node, stateWith(data))).toBe(false);
  });

  it('does not report a field that was simply never supplied', async () => {
    // Absent required fields are computeMissingFields' job, not the validator's — otherwise
    // every partial mid-accumulation state would look "invalid".
    expect(await invalidCollectFields(node, { unitId: 'A-101' })).toEqual([]);
  });

  it('still reports SHAPE only — a valid string for a nonexistent unit passes', async () => {
    // The live "12B" failure is a referent problem, not a shape problem. Only a tool
    // boundary knows the portfolio. This test pins that boundary so nobody assumes schema
    // validation closed it.
    expect(await schemaSatisfied(node, stateWith({ unitId: '12B', urgency: 'routine' }))).toBe(true);
  });
});

describe('collect completion honors async non-Zod Standard Schema implementations', () => {
  const asyncSchema: StandardSchemaV1<
    unknown,
    { ticket: string; priority: 'normal' | 'urgent' }
  > = {
    '~standard': {
      version: 1,
      vendor: 'async-review-schema',
      validate: async (value) => {
        await Promise.resolve();
        if (
          typeof value === 'object' &&
          value !== null &&
          'ticket' in value &&
          typeof value.ticket === 'string' &&
          'priority' in value &&
          (value.priority === 'normal' || value.priority === 'urgent')
        ) {
          return {
            value: {
              ticket: value.ticket.trim().toUpperCase(),
              priority: value.priority,
            },
          };
        }
        return { issues: [{ message: 'ticket and priority are required' }] };
      },
    },
  };
  const asyncNode = collect({
    id: 'async-standard',
    schema: asyncSchema,
    required: ['ticket', 'priority'],
    onComplete: () => ({ end: 'done' }),
  });

  it('rejects absent and invalid complete objects', async () => {
    expect(await schemaSatisfied(asyncNode, {})).toBe(false);
    expect(
      await schemaSatisfied(asyncNode, {
        '__collect_async-standard': { ticket: 't-7', priority: 'later' },
      }),
    ).toBe(false);
  });

  it('awaits validation and projects the schema output rather than the unvalidated input', async () => {
    const state = {
      '__collect_async-standard': { ticket: '  t-7 ', priority: 'urgent' },
    };
    expect(await schemaSatisfied(asyncNode, state)).toBe(true);
    expect(await projectCollectData(asyncNode, state)).toEqual({
      ticket: 'T-7',
      priority: 'urgent',
    });
  });
});
