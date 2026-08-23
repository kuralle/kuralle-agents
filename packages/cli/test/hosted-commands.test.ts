import { describe, expect, it } from 'bun:test';
import { messageFrom } from '../src/send.js';

describe('messageFrom', () => {
  it('strips --store and its value from the hosted send message', () => {
    expect(messageFrom(['--store', 'runs/x.json', 'check', 'my', 'order'])).toBe('check my order');
  });

  it('strips --summary and its value from the hosted send message', () => {
    expect(messageFrom(['--summary', 'Refund issued.', 'resume', 'please'])).toBe('resume please');
  });

  it('strips every value-taking flag when several are interleaved', () => {
    // The single-flag cases pass even against an implementation that only ever
    // skips index 1. Several flags in sequence are what exercise the
    // "token follows a value-taking flag" rule at every position.
    expect(messageFrom([
      '--session', 'abc-123',
      '--store', 'runs/x.json',
      '--server', 'https://example.test',
      '--token', 'secret-value',
      'where', 'is', 'my', 'order',
    ])).toBe('where is my order');
  });

  it('keeps the first message word after a flag that takes NO value', () => {
    // The inverse failure, and the more damaging one: adding a boolean flag to
    // `consumesValue` would silently eat the first word of the user's message.
    // `--state`, `--reset`, `--trace` and `--local` take no value (see the
    // Options block in cli.ts), so the word after them is message text.
    expect(messageFrom(['--state', 'check', 'my', 'order'])).toBe('check my order');
    expect(messageFrom(['--reset', 'check', 'my', 'order'])).toBe('check my order');
    expect(messageFrom(['--trace', 'check', 'my', 'order'])).toBe('check my order');
    expect(messageFrom(['--local', 'check', 'my', 'order'])).toBe('check my order');
  });
});
