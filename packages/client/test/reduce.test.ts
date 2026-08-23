import { describe, expect, it } from 'bun:test';
import { PART_CHANNEL } from '@kuralle-agents/core';
import { reduce } from '../src/reduce.js';
import {
  approvalPauseEvents,
  coverageEvents,
  errorEvents,
  flowTurnEvents,
  handoffEvents,
  lateExtractionEvents,
  sampleInterrupt,
  toolTurnEvents,
} from './fixtures.js';

describe('reduce', () => {
  it('folds a tool turn with preliminary result and TTFT on first non-empty delta', () => {
    const view = reduce(toolTurnEvents);
    expect(view.status).toBe('completed');
    expect(view.timings.ttftMs).toBe(50);
    expect(view.timings.totalMs).toBe(600);
    expect(view.usage.inputTokens).toBe(120);

    const assistant = view.blocks.find((b) => b.kind === 'assistant');
    expect(assistant).toMatchObject({ text: 'Checking your order.', streaming: false });

    const tool = view.blocks.find((b) => b.kind === 'tool' && b.id === 'call-1');
    expect(tool).toMatchObject({
      name: 'lookup_order',
      state: 'ok',
      result: { status: 'shipped', carrier: 'DHL' },
      ms: 200,
    });
  });

  it('folds flow lifecycle blocks', () => {
    const view = reduce(flowTurnEvents);
    expect(view.status).toBe('completed');
    const flows = view.blocks.filter((b) => b.kind === 'flow');
    expect(flows.map((b) => b.phase)).toEqual(['enter', 'enter', 'transition', 'end', 'end']);
  });

  it('carries the full HitlInterrupt on pending for approval pause', () => {
    const view = reduce(approvalPauseEvents);
    expect(view.status).toBe('input-required');
    expect(view.pending).toHaveLength(1);
    expect(view.pending[0]).toEqual(sampleInterrupt);
  });

  it('folds handoff blocks', () => {
    const view = reduce(handoffEvents);
    expect(view.blocks).toContainEqual({
      id: '0:handoff',
      kind: 'handoff',
      to: 'billing',
      reason: 'refund',
    });
  });

  it('marks errors as failed with a notice block', () => {
    const view = reduce(errorEvents);
    expect(view.status).toBe('failed');
    expect(view.blocks.some((b) => b.kind === 'notice' && b.level === 'error')).toBe(true);
  });

  it('accepts late extraction after done without reopening the turn', () => {
    const view = reduce(lateExtractionEvents);
    expect(view.status).toBe('completed');
    expect(view.memory.extracted).toEqual([
      { slug: 'preference.seat', value: 'window', at: 800 },
    ]);
  });

  it('covers every StreamPayloadMap key via fixtures', () => {
    const seen = new Set<string>();
    for (const event of [
      ...toolTurnEvents,
      ...flowTurnEvents,
      ...approvalPauseEvents,
      ...handoffEvents,
      ...errorEvents,
      ...lateExtractionEvents,
      ...coverageEvents,
    ]) {
      seen.add(event.part.type);
    }
    for (const type of Object.keys(PART_CHANNEL)) {
      expect(seen.has(type)).toBe(true);
    }
  });

  it('records context compaction in memory.compactions', () => {
    const view = reduce(coverageEvents);
    expect(view.memory.compactions).toHaveLength(1);
    expect(view.memory.compactions[0]?.beforeTokens).toBe(9000);
  });
});
