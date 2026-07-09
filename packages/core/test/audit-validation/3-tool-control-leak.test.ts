// FINDING 3: Tool return value drives flow control AND carries user-facing prose (final result leak) | anchor src/flow/classifyControl.ts:7, src/tools/final.ts | why this proves it
import { describe, expect, it } from 'bun:test';
import { classifyControl } from '../../src/flow/classifyControl.js';

describe('F3: final tool result prose drives end control', () => {
  it('classifyControl maps FinalResult.text to end.reason (user-facing prose in control channel)', () => {
    const prose = 'goodbye, see you';
    const control = classifyControl({ type: 'final', text: prose });

    expect(control).toBeDefined();
    expect(control?.type).toBe('end');
    expect(control?.reason).toBe(prose);
  });
});