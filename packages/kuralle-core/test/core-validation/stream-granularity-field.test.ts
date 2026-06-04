import { describe, expect, it } from 'bun:test';
import type { ValidationCapability } from '../../src/capabilities/ValidationCapability.js';
import type { OutputProcessor } from '../../src/types/processors.js';

describe('streamGranularity field on gate interfaces', () => {
  it('accepts OutputProcessor and ValidationCapability with streamGranularity: sentence', () => {
    const processor: OutputProcessor = {
      id: 'p-sentence',
      streamGranularity: 'sentence',
      process: () => ({ action: 'allow' }),
    };
    const policy: ValidationCapability = {
      name: 'v-sentence',
      streamGranularity: 'sentence',
      validate: async () => ({ decision: 'continue', confidence: 1 }),
    };

    expect(processor.streamGranularity).toBe('sentence');
    expect(policy.streamGranularity).toBe('sentence');
  });

  it('accepts OutputProcessor and ValidationCapability without streamGranularity', () => {
    const processor: OutputProcessor = {
      id: 'p-default',
      process: () => ({ action: 'allow' }),
    };
    const policy: ValidationCapability = {
      name: 'v-default',
      validate: async () => ({ decision: 'continue', confidence: 1 }),
    };

    expect(processor.streamGranularity).toBeUndefined();
    expect(policy.streamGranularity).toBeUndefined();
  });

  it('round-trips streamGranularity: turn when declared', () => {
    const processor: OutputProcessor = {
      id: 'p-turn',
      streamGranularity: 'turn',
      process: () => ({ action: 'allow' }),
    };
    const policy: ValidationCapability = {
      name: 'v-turn',
      streamGranularity: 'turn',
      validate: async () => ({ decision: 'continue', confidence: 1 }),
    };

    expect(processor.streamGranularity).toBe('turn');
    expect(policy.streamGranularity).toBe('turn');
  });
});
