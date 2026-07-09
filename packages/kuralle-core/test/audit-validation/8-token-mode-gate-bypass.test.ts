// FINDING 8: in token stream mode speakGated never invokes the gate, so applyPostTurnPolicies (output processors, validation, control extraction) is silently skipped for the whole turn | anchor src/runtime/channels/streaming/speakGated.ts:105-131, src/runtime/channels/streaming/mode.ts:10-18 | proves a processor that declares streamGranularity 'token' disables its own enforcement
import { describe, expect, it } from 'bun:test';
import type { RunContext } from '../../src/types/run-context.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import { speakGated } from '../../src/runtime/channels/streaming/speakGated.js';

describe('F8: token-mode streaming bypasses the output gate entirely', () => {
  it('runGate is never called in token mode; all deltas reach the consumer', async () => {
    const emitted: HarnessStreamPart[] = [];
    const ctx = { emit: (part: HarnessStreamPart) => emitted.push(part) } as unknown as RunContext;

    const gateCalls: string[] = [];
    const runGate = async (text: string) => {
      gateCalls.push(text);
      return { blocked: true, text: 'BLOCKED' };
    };

    const source = {
      async *[Symbol.asyncIterator]() {
        yield { delta: 'leak the ' };
        yield { delta: 'unmoderated answer' };
      },
    };

    const spoken = await speakGated({ ctx, mode: 'token', turnId: 't1', source, runGate });

    // CURRENT behavior: the gate — which would have blocked — never ran.
    expect(gateCalls).toEqual([]);
    expect(spoken.text).toBe('leak the unmoderated answer');
    const deltas = emitted.filter((p) => p.type === 'text-delta');
    expect(deltas).toHaveLength(2);
  });
});
