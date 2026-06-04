import { describe, expect, it } from 'bun:test';
import { createDeferredTokenSource } from '../../src/runtime/channels/streaming/deferredTokenSource.js';

describe('createDeferredTokenSource', () => {
  it('yields pushed deltas then ends on close', async () => {
    const { source, push, close } = createDeferredTokenSource();
    push('a');
    push('b');
    close();

    const deltas: string[] = [];
    for await (const { delta } of source) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(['a', 'b']);
  });

  it('throws on interrupted close so consumers can cancel', async () => {
    const { source, push, close } = createDeferredTokenSource();
    push('partial');
    close('interrupted');

    const deltas: string[] = [];
    await expect(
      (async () => {
        for await (const { delta } of source) {
          deltas.push(delta);
        }
      })(),
    ).rejects.toThrow('interrupted');
    expect(deltas).toEqual(['partial']);
  });
});
