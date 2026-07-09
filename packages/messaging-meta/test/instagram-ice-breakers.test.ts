import { describe, it, expect } from 'bun:test';
import {
  buildIceBreakerConfig,
  validateIceBreakers,
  MAX_ICE_BREAKERS,
} from '../src/instagram/ice-breakers.ts';

describe('buildIceBreakerConfig', () => {
  it('builds a config from question-payload pairs', () => {
    const config = buildIceBreakerConfig([
      { question: 'What are your hours?', payload: 'HOURS' },
      { question: 'Where are you located?', payload: 'LOCATION' },
    ]);

    expect(config.call_to_actions).toHaveLength(2);
    expect(config.call_to_actions[0].question).toBe('What are your hours?');
    expect(config.call_to_actions[0].payload).toBe('HOURS');
    expect(config.call_to_actions[1].question).toBe('Where are you located?');
    expect(config.call_to_actions[1].payload).toBe('LOCATION');
  });

  it('truncates items exceeding MAX_ICE_BREAKERS (4)', () => {
    const items = [
      { question: 'Q1', payload: 'P1' },
      { question: 'Q2', payload: 'P2' },
      { question: 'Q3', payload: 'P3' },
      { question: 'Q4', payload: 'P4' },
      { question: 'Q5', payload: 'P5' },
    ];
    const config = buildIceBreakerConfig(items);

    expect(config.call_to_actions).toHaveLength(MAX_ICE_BREAKERS);
    expect(config.call_to_actions).toHaveLength(4);
  });

  it('sets locale when provided', () => {
    const config = buildIceBreakerConfig(
      [{ question: 'Q', payload: 'P' }],
      'en_US',
    );
    expect(config.locale).toBe('en_US');
  });

  it('omits locale when not provided', () => {
    const config = buildIceBreakerConfig([{ question: 'Q', payload: 'P' }]);
    expect(config.locale).toBeUndefined();
  });

  it('handles empty items array', () => {
    const config = buildIceBreakerConfig([]);
    expect(config.call_to_actions).toHaveLength(0);
  });
});

describe('validateIceBreakers', () => {
  it('returns empty array for valid configs', () => {
    const errors = validateIceBreakers([
      {
        call_to_actions: [
          { question: 'What are your hours?', payload: 'HOURS' },
          { question: 'Where are you located?', payload: 'LOCATION' },
        ],
      },
    ]);
    expect(errors).toHaveLength(0);
  });

  it('reports error when exceeding MAX_ICE_BREAKERS', () => {
    const errors = validateIceBreakers([
      {
        call_to_actions: [
          { question: 'Q1', payload: 'P1' },
          { question: 'Q2', payload: 'P2' },
          { question: 'Q3', payload: 'P3' },
          { question: 'Q4', payload: 'P4' },
          { question: 'Q5', payload: 'P5' },
        ],
      },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('exceeds maximum');
  });

  it('reports error for missing question', () => {
    const errors = validateIceBreakers([
      {
        call_to_actions: [
          { question: '', payload: 'P1' },
        ],
      },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('question');
  });

  it('reports error for missing payload', () => {
    const errors = validateIceBreakers([
      {
        call_to_actions: [
          { question: 'Q1', payload: '' },
        ],
      },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('payload');
  });

  it('reports multiple errors', () => {
    const errors = validateIceBreakers([
      {
        call_to_actions: [
          { question: '', payload: '' },
          { question: 'Valid', payload: 'VALID' },
          { question: '', payload: 'P3' },
        ],
      },
    ]);
    // Should have errors for item 0 (question + payload) and item 2 (question)
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('returns empty array for empty configs array', () => {
    const errors = validateIceBreakers([]);
    expect(errors).toHaveLength(0);
  });
});
