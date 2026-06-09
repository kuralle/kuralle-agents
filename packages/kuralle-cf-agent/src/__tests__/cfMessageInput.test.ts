import { describe, expect, it } from 'bun:test';
import type { UIMessage } from 'ai';
import { lastUserInputFromMessages } from '../cfMessageInput.js';

const userMsg = (parts: UIMessage['parts']): UIMessage => ({ id: 'u', role: 'user', parts });

describe('lastUserInputFromMessages', () => {
  it('returns a plain string for a text-only turn', () => {
    expect(lastUserInputFromMessages([userMsg([{ type: 'text', text: 'hello' }])])).toBe('hello');
  });

  it('maps an image file part to a FilePart alongside text', () => {
    const out = lastUserInputFromMessages([
      userMsg([
        { type: 'text', text: 'read this rx' },
        { type: 'file', url: 'https://blob/x.png', mediaType: 'image/png', filename: 'rx.png' },
      ]),
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'read this rx' },
      { type: 'file', data: 'https://blob/x.png', mediaType: 'image/png', filename: 'rx.png' },
    ]);
  });

  it('handles an image-only turn (no caption)', () => {
    const out = lastUserInputFromMessages([
      userMsg([{ type: 'file', url: 'https://blob/x.jpg', mediaType: 'image/jpeg' }]),
    ]);
    expect(out).toEqual([
      { type: 'file', data: 'https://blob/x.jpg', mediaType: 'image/jpeg', filename: undefined },
    ]);
  });

  it('scans backwards to the latest user turn', () => {
    const out = lastUserInputFromMessages([
      userMsg([{ type: 'text', text: 'old' }]),
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
      userMsg([{ type: 'text', text: 'new' }]),
    ]);
    expect(out).toBe('new');
  });

  it('returns null when there is no usable user content', () => {
    expect(lastUserInputFromMessages([])).toBeNull();
    expect(lastUserInputFromMessages([userMsg([{ type: 'text', text: '   ' }])])).toBeNull();
  });
});
