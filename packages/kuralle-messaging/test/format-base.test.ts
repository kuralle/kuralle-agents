import { describe, it, expect } from 'bun:test';
import { passthroughFormatter } from '../src/shared/format-base.js';
import type { MessageFormatter } from '../src/shared/format-base.js';

describe('passthroughFormatter', () => {
  const formatter: MessageFormatter = passthroughFormatter;

  it('returns markdown unchanged', () => {
    expect(formatter.toPlatformFormat('**bold**')).toBe('**bold**');
  });

  it('handles empty string', () => {
    expect(formatter.toPlatformFormat('')).toBe('');
  });

  it('preserves multiline text', () => {
    const text = 'line 1\nline 2\nline 3';
    expect(formatter.toPlatformFormat(text)).toBe(text);
  });
});
