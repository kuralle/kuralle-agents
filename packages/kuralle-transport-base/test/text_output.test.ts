import { describe, it, expect } from 'bun:test';
import { createCallbackTextOutput } from '../src/text_output.js';

describe('createCallbackTextOutput', () => {
  it('passes non-empty text chunks to serialize + send', async () => {
    const sent: string[] = [];
    const out = createCallbackTextOutput({
      serialize: ({ text, isFinal }) => JSON.stringify({ text, isFinal }),
      send: (payload) => {
        sent.push(payload as string);
      },
    });

    await out.captureText('hello ');
    await out.captureText('world');

    expect(sent).toEqual([
      JSON.stringify({ text: 'hello ', isFinal: false }),
      JSON.stringify({ text: 'world', isFinal: false }),
    ]);
  });

  it('emits a final serialize call on flush by default', async () => {
    const sent: string[] = [];
    const out = createCallbackTextOutput({
      serialize: ({ text, isFinal }) => `${text}|${isFinal}`,
      send: (payload) => {
        sent.push(payload as string);
      },
    });

    await out.captureText('foo');
    out.flush();

    expect(sent).toEqual(['foo|false', '|true']);
  });

  it('omits the final marker when emitFinalOnFlush=false', async () => {
    const sent: string[] = [];
    const out = createCallbackTextOutput({
      serialize: ({ text, isFinal }) => `${text}|${isFinal}`,
      send: (payload) => {
        sent.push(payload as string);
      },
      emitFinalOnFlush: false,
    });

    await out.captureText('foo');
    out.flush();

    expect(sent).toEqual(['foo|false']);
  });

  it('ignores further captureText after close', async () => {
    const sent: string[] = [];
    const out = createCallbackTextOutput({
      serialize: ({ text }) => text,
      send: (payload) => {
        sent.push(payload as string);
      },
    });

    await out.captureText('a');
    await out.close();
    await out.captureText('b');

    expect(sent).toEqual(['a']);
  });

  it('swallows send() errors', async () => {
    const out = createCallbackTextOutput({
      serialize: ({ text }) => text,
      send: () => {
        throw new Error('pipe closed');
      },
    });

    await expect(out.captureText('hi')).resolves.toBeUndefined();
  });

  it('skips delivery when serialize returns null', async () => {
    const sent: string[] = [];
    const out = createCallbackTextOutput({
      serialize: ({ text }) => (text === 'skip' ? null : text),
      send: (payload) => {
        sent.push(payload as string);
      },
    });

    await out.captureText('keep');
    await out.captureText('skip');
    await out.captureText('keep2');

    expect(sent).toEqual(['keep', 'keep2']);
  });

  it('supports binary payloads (Uint8Array)', async () => {
    const sent: Uint8Array[] = [];
    const out = createCallbackTextOutput({
      serialize: ({ text }) => new TextEncoder().encode(text),
      send: (payload) => {
        sent.push(payload as Uint8Array);
      },
    });

    await out.captureText('bytes');

    expect(sent).toHaveLength(1);
    expect(new TextDecoder().decode(sent[0]!)).toBe('bytes');
  });
});
