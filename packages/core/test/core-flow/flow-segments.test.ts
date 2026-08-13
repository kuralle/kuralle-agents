import { describe, expect, it } from 'bun:test';
import { defineFlow, reply } from '../../src/types/flow.js';
import type { FlowDefinition, FlowNodeDefinition, TransitionRef } from '../../src/flows/definition/types.js';
import { rehydrateFlow } from '../../src/flows/definition/rehydrate.js';
import {
  MAX_SEGMENT_LENGTH,
  MAX_SEGMENTS,
  computeFlowSegments,
  segmentStartingAt,
  segmentsForLiveFlow,
} from '../../src/flows/definition/segments.js';

function def(nodes: FlowNodeDefinition[], start = nodes[0]!.id): FlowDefinition {
  return { name: 'seg', description: '', start, nodes };
}

function generate(id: string, next: TransitionRef, instructions?: string): FlowNodeDefinition {
  return { kind: 'reply', id, generate: true, ...(instructions ? { instructions } : {}), next };
}

function template(id: string, next: TransitionRef): FlowNodeDefinition {
  return { kind: 'reply', id, response: { template: 'ok' }, next };
}

function act(id: string, next: TransitionRef, extra?: { approval?: true; routes?: true }): FlowNodeDefinition {
  return {
    kind: 'action',
    id,
    tool: 'noop',
    next,
    ...(extra?.approval ? { approval: true as const } : {}),
    ...(extra?.routes
      ? { routes: [{ when: { op: 'truthy' as const, value: { path: 'state.x' } }, to: { end: 'x' as const } }] }
      : {}),
  };
}

describe('computeFlowSegments', () => {
  it('batches three consecutive generate replies into one chain and indexes suffixes', () => {
    const segments = computeFlowSegments(
      def([
        generate('a', { goto: 'b' }),
        generate('b', { goto: 'c' }),
        generate('c', { end: 'done' }),
      ]),
    );
    expect(segments.get('a')?.nodeIds).toEqual(['a', 'b', 'c']);
    expect(segments.get('a')?.kind).toBe('generate-replies');
    expect(segments.get('b')?.nodeIds).toEqual(['b', 'c']);
    expect(segments.get('c')).toBeUndefined();
  });

  it('batches three consecutive non-approval actions', () => {
    const segments = computeFlowSegments(
      def([act('a', { goto: 'b' }), act('b', { goto: 'c' }), act('c', { end: 'done' })]),
    );
    expect(segments.get('a')?.nodeIds).toEqual(['a', 'b', 'c']);
    expect(segments.get('a')?.kind).toBe('actions');
  });

  it('splits at decide, collect, approval, template reply, and routes', () => {
    const segments = computeFlowSegments(
      def([
        generate('g1', { goto: 'dec' }),
        { kind: 'decide', id: 'dec', otherwise: { goto: 'g2' } },
        generate('g2', { goto: 'col' }),
        {
          kind: 'collect',
          id: 'col',
          schema: { type: 'object', properties: { x: { type: 'string' } } },
          next: { goto: 'a1' },
        },
        act('a1', { goto: 'ap' }),
        act('ap', { goto: 'a2' }, { approval: true }),
        act('a2', { goto: 'tmpl' }),
        template('tmpl', { goto: 'g3' }),
        generate('g3', { goto: 'routed' }),
        {
          kind: 'reply',
          id: 'routed',
          generate: true,
          routes: [{ when: { op: 'truthy', value: { path: 'state.x' } }, to: { end: 'x' } }],
          next: { goto: 'a3' },
        },
        act('a3', { goto: 'a4' }, { routes: true }),
        act('a4', { end: 'done' }),
      ]),
    );
    expect(segments.get('g1')).toBeUndefined();
    expect(segments.get('g2')).toBeUndefined();
    expect(segments.get('a1')).toBeUndefined();
    expect(segments.get('a2')).toBeUndefined();
    expect(segments.get('g3')).toBeUndefined();
    expect(segments.get('a3')).toBeUndefined();
    expect(segments.get('a4')).toBeUndefined();
  });

  it('treats a template reply as a boundary even between generate replies', () => {
    const segments = computeFlowSegments(
      def([generate('a', { goto: 't' }), template('t', { goto: 'b' }), generate('b', { end: 'done' })]),
    );
    expect(segments.size).toBe(0);
  });

  it('does not grow through goto data or interpolating generate instructions', () => {
    const segments = computeFlowSegments(
      def([
        generate('a', { goto: 'b', data: { k: 1 } }),
        generate('b', { goto: 'c' }),
        generate('c', { goto: 'd' }, 'Use ${state.x}'),
        generate('d', { end: 'done' }),
      ]),
    );
    expect(segments.get('a')).toBeUndefined();
    expect(segments.get('c')).toBeUndefined();
    expect(segments.get('b')).toBeUndefined();
  });

  it('splits mixed generate-reply / action chains at the kind change', () => {
    const segments = computeFlowSegments(
      def([
        generate('r1', { goto: 'a1' }),
        act('a1', { goto: 'a2' }),
        act('a2', { goto: 'r2' }),
        generate('r2', { end: 'done' }),
      ]),
    );
    expect(segments.get('r1')).toBeUndefined();
    expect(segments.get('a1')?.nodeIds).toEqual(['a1', 'a2']);
    expect(segments.get('a1')?.kind).toBe('actions');
    expect(segments.get('r2')).toBeUndefined();
  });

  it(`caps a chain at ${MAX_SEGMENT_LENGTH} and continues a new chain after the cap`, () => {
    const nodes: FlowNodeDefinition[] = [];
    for (let i = 0; i < MAX_SEGMENT_LENGTH + 2; i++) {
      const id = `n${i}`;
      const next = i === MAX_SEGMENT_LENGTH + 1 ? { end: 'done' as const } : { goto: `n${i + 1}` };
      nodes.push(act(id, next));
    }
    const segments = computeFlowSegments(def(nodes));
    expect(segments.get('n0')?.nodeIds).toHaveLength(MAX_SEGMENT_LENGTH);
    expect(segments.get(`n${MAX_SEGMENT_LENGTH}`)?.nodeIds).toEqual([
      `n${MAX_SEGMENT_LENGTH}`,
      `n${MAX_SEGMENT_LENGTH + 1}`,
    ]);
  });

  it(`caps total maximal segments at ${MAX_SEGMENTS}`, () => {
    const nodes: FlowNodeDefinition[] = [];
    for (let i = 0; i < MAX_SEGMENTS + 1; i++) {
      nodes.push(act(`a${i}`, { goto: `b${i}` }), act(`b${i}`, { end: `e${i}` }));
    }
    const segments = computeFlowSegments(def(nodes));
    const maximals = [...segments.entries()].filter(([, seg]) => seg.nodeIds.length === 2);
    expect(maximals).toHaveLength(MAX_SEGMENTS);
    expect(segments.get(`a${MAX_SEGMENTS}`)).toBeUndefined();
  });

  it('does not form a cyclic segment', () => {
    const segments = computeFlowSegments(def([act('a', { goto: 'b' }), act('b', { goto: 'a' })]));
    expect(segments.get('a')?.nodeIds).toEqual(['a', 'b']);
    expect(segments.get('b')).toBeUndefined();
  });
});

describe('segmentsForLiveFlow', () => {
  it('returns the same cached map for a rehydrated flow', () => {
    const flow = rehydrateFlow(def([generate('a', { goto: 'b' }), generate('b', { end: 'done' })]), {
      tools: () => undefined,
    });
    expect(segmentsForLiveFlow(flow)).toBe(segmentsForLiveFlow(flow));
    expect(segmentStartingAt(flow, 'a')?.nodeIds).toEqual(['a', 'b']);
  });

  it('returns an empty map for code-authored flows (closures cannot prove unconditional next)', () => {
    const a = reply({ id: 'a', instructions: 'one', next: () => b });
    const b = reply({ id: 'b', instructions: 'two', next: () => ({ end: 'done' }) });
    const flow = defineFlow({ name: 'code', description: '', start: a, nodes: [a, b] });
    expect(segmentsForLiveFlow(flow).size).toBe(0);
  });
});
