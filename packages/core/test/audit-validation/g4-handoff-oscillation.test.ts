import { describe, expect, it } from 'bun:test';
import { isHandoffOscillating } from '../../src/runtime/handoffOscillation.js';

describe('G4: cross-turn handoff oscillation suppression', () => {
  it('detects A↔B oscillation when consecutive same-pair hops reach threshold', () => {
    const history = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ];
    expect(isHandoffOscillating(history, 'B', 'A', 3)).toBe(true);
  });

  it('returns false when pending hop is a different pair', () => {
    const history = [{ from: 'A', to: 'B' }];
    expect(isHandoffOscillating(history, 'A', 'C', 3)).toBe(false);
  });

  it('returns false with empty history below threshold', () => {
    expect(isHandoffOscillating([], 'A', 'B', 3)).toBe(false);
  });
});