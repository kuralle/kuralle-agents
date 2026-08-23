import { describe, expect, it } from 'bun:test';
import { failedFixture, inputRequiredFixture, waitingFixture } from './fixtures/turn-result-fixtures.js';
import { resolveOperation } from '../src/resolveOperation.js';

describe('resolveOperation', () => {
  it('rejects resuming a failed result', () => {
    expect(() => resolveOperation('hi', undefined, false, false, undefined, failedFixture))
      .toThrow('a terminal failed result cannot be resumed');
  });

  it('rejects input-required without prompt or respond', () => {
    expect(() => resolveOperation('', undefined, false, false, undefined, inputRequiredFixture))
      .toThrow('input-required: pass a message or --respond');
  });

  it('rejects a follow-up prompt while streaming', () => {
    const streaming = {
      ...waitingFixture,
      view: {
        ...waitingFixture.view,
        status: 'streaming' as const,
      },
    };
    expect(() => resolveOperation('continue', undefined, false, false, undefined, streaming))
      .toThrow('a running invocation cannot accept a follow-up prompt');
  });
});
