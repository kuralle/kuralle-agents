import { describe, expect, test } from 'bun:test';
import { normalizeUiMessages, normalizeModelMessages } from './admin.js';

describe('admin transcript normalization', () => {
  test('web UIMessages → flat transcript (text parts only, roles filtered)', () => {
    const out = normalizeUiMessages([
      { role: 'user', parts: [{ type: 'text', text: 'hi ' }, { type: 'text', text: 'there' }] },
      { role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'Hello!' }] },
      { role: 'assistant', parts: [{ type: 'tool-foo' }] }, // no text → dropped
      { role: 'data', parts: [{ type: 'text', text: 'x' }] }, // non-conv role → dropped
    ] as never);
    expect(out).toEqual([
      { role: 'user', text: 'hi there' },
      { role: 'assistant', text: 'Hello!' },
    ]);
  });

  test('WhatsApp ModelMessages → flat transcript (string + parts content)', () => {
    const out = normalizeModelMessages([
      { role: 'user', content: 'can i get paracetamol' },
      { role: 'assistant', content: [{ type: 'text', text: 'Sure — added.' }, { type: 'tool-call' }] },
      { role: 'assistant', content: [{ type: 'tool-call' }] }, // no text → dropped
    ] as never);
    expect(out).toEqual([
      { role: 'user', text: 'can i get paracetamol' },
      { role: 'assistant', text: 'Sure — added.' },
    ]);
  });
});
