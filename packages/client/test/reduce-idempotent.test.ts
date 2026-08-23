import { describe, expect, it } from 'bun:test';
import { reduce } from '../src/reduce.js';
import { lateExtractionEvents, toolTurnEvents } from './fixtures.js';

describe('reduce idempotency', () => {
  it('yields the same view when the same events are folded twice with prior', () => {
    const once = reduce(toolTurnEvents);
    const twice = reduce(toolTurnEvents, once);
    expect(twice).toEqual(once);
  });

  it('yields the same view for overlapping halves', () => {
    const events = toolTurnEvents;
    const split = 5;
    const overlap = 2;
    const first = events.slice(0, split);
    const second = events.slice(split - overlap);

    const full = reduce(events);
    const part = reduce(first);
    const merged = reduce(second, part);
    expect(merged).toEqual(full);
  });

  it('does not duplicate blocks when the same eventId is replayed', () => {
    const duplicate = [...toolTurnEvents, ...toolTurnEvents];
    const view = reduce(duplicate);
    const once = reduce(toolTurnEvents);
    expect(view).toEqual(once);
  });

  it('keeps terminal status when a late extraction is replayed with prior', () => {
    const done = reduce(lateExtractionEvents.slice(0, 4));
    expect(done.status).toBe('completed');

    const withExtraction = reduce(lateExtractionEvents, done);
    expect(withExtraction.status).toBe('completed');
    expect(withExtraction.memory.extracted).toHaveLength(1);

    const replay = reduce(lateExtractionEvents, withExtraction);
    expect(replay).toEqual(withExtraction);
  });
});
