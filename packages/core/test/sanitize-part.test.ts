import { describe, expect, it } from 'bun:test';
import { sanitizePart } from '../src/events/sanitizePart.ts';

describe('sanitizePart', () => {
  it('redacts secret-shaped error payloads', () => {
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const input = {
        channel: 'client' as const,
        type: 'error' as const,
        payload: { error: 'OpenAI API error: Invalid API key sk-proj-abc123def456' },
      };
      const output = sanitizePart(input);
      expect(output).toEqual({
        channel: 'client',
        type: 'error',
        payload: { error: 'An error occurred. Please try again.' },
      });
      expect(logs.length).toBeGreaterThanOrEqual(1);
    } finally {
      console.error = original;
    }
  });

  it('returns non-error parts unchanged', () => {
    const input = {
      channel: 'client' as const,
      type: 'text-delta' as const,
      payload: { id: 't', delta: 'hi' },
    };
    expect(sanitizePart(input)).toEqual(input);
  });
});
