import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect } from '../../src/authoring/nodes.js';
import { invalidCollectFields, schemaSatisfied } from '../../src/flow/extraction.js';

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
  it('rejects an enum value the model invented', () => {
    const state = stateWith({ unitId: 'A-101', urgency: 'high' });
    expect(invalidCollectFields(node, { unitId: 'A-101', urgency: 'high' })).toContain('urgency');
    expect(schemaSatisfied(node, state)).toBe(false);
  });

  it('accepts a valid value', () => {
    const state = stateWith({ unitId: 'A-101', urgency: 'urgent' });
    expect(schemaSatisfied(node, state)).toBe(true);
  });

  it('rejects a malformed optional field that was supplied', () => {
    const data = { unitId: 'A-101', urgency: 'routine', contactEmail: 'not-an-email' };
    expect(invalidCollectFields(node, data)).toContain('contactEmail');
    expect(schemaSatisfied(node, stateWith(data))).toBe(false);
  });

  it('does not report a field that was simply never supplied', () => {
    // Absent required fields are computeMissingFields' job, not the validator's — otherwise
    // every partial mid-accumulation state would look "invalid".
    expect(invalidCollectFields(node, { unitId: 'A-101' })).toEqual([]);
  });

  it('still reports SHAPE only — a valid string for a nonexistent unit passes', () => {
    // The live "12B" failure is a referent problem, not a shape problem. Only a tool
    // boundary knows the portfolio. This test pins that boundary so nobody assumes schema
    // validation closed it.
    expect(schemaSatisfied(node, stateWith({ unitId: '12B', urgency: 'routine' }))).toBe(true);
  });
});
