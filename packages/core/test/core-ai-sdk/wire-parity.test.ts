/**
 * Three serialisers turn a `StreamPart` sequence into frames for a browser
 * client, and nothing structurally stops them drifting apart.
 *
 * `harnessToUIMessageStream` is pinned by an exhaustiveness guard, so an
 * unmapped client variant fails the build. The cf-agent serialiser ends its
 * switch with a plain `break`, so an unmapped variant is silently dropped —
 * including `interactive`, `safety-blocked` and `paused`, which are the HITL
 * and safety parts. A safety property enforced in the engine and lost at the
 * wire is not enforced.
 *
 * This test compares whole frames, not just `type`: the divergences include a
 * missing `id` on text frames and differently-named `data-*` parts, both of
 * which a type-only comparison waves through.
 */

import { describe, expect, it } from 'bun:test';
import {
  ALL_CLIENT_STREAM_PARTS,
  asStreamPartSource,
  drainSSEFrames,
} from '../../src/testing/streamFixture.ts';
import { createUIMessageStreamResponse } from 'ai';
import { harnessToUIMessageStream } from '../../src/ai-sdk/uiMessageStream.ts';

/**
 * The reference: what every surface must emit ON THE WIRE.
 *
 * `harnessToUIMessageStream` yields chunk objects; the SSE encoding lives in
 * `createUIMessageStreamResponse`. Comparing at the HTTP body is what makes
 * this test comparable against the other two surfaces, which are HTTP routes.
 */
async function referenceFrames(): Promise<Array<Record<string, unknown>>> {
  const response = createUIMessageStreamResponse({
    stream: harnessToUIMessageStream(asStreamPartSource(), { sessionId: 's1' }),
  });
  return drainSSEFrames(response.body!);
}

describe('UIMessageStream wire parity', () => {
  it('maps every part the adapter knows about, in order', async () => {
    const frames = await referenceFrames();
    const types = frames.map(frame => frame.type);

    // Text lifecycle keeps its id, so interleaved segments stay separable.
    expect(frames).toContainEqual({ type: 'text-start', id: 't1' });
    expect(frames).toContainEqual({ type: 'text-delta', id: 't1', delta: 'Hello' });
    expect(frames).toContainEqual({ type: 'text-end', id: 't1' });

    // The parts a diverging serialiser is most likely to drop: HITL + safety.
    expect(types).toContain('data-kuralle-interactive');
    expect(types).toContain('data-kuralle-safety');
    expect(types).toContain('data-kuralle-control');
    expect(types).toContain('data-kuralle-handoff');
    expect(types).toContain('data-kuralle-outcome');

    // `sessionId` reaches the client as message metadata, not as a data part.
    expect(types).toContain('start');
  });

  it('names Kuralle data parts under the kuralle- prefix', async () => {
    const frames = await referenceFrames();
    const dataTypes = frames
      .map(frame => String(frame.type))
      .filter(type => type.startsWith('data-'));

    // A client typed against KuralleUIMessage matches on these exact names;
    // `data-handoff` or `data-flow-enter` would silently match nothing.
    for (const type of dataTypes) {
      expect(type.startsWith('data-kuralle-')).toBe(true);
    }
    expect(dataTypes.length).toBeGreaterThan(0);
  });

  it('surfaces an error as a real error frame, not a data part', async () => {
    const frames = await referenceFrames();
    const types = frames.map(frame => String(frame.type));

    // `useChat` only raises what arrives as an error part. A `data-error`
    // carries the text but never reaches the client's error handler.
    expect(types).toContain('error');
    expect(types).not.toContain('data-error');
  });

  it('covers every variant the adapter switches on', async () => {
    // The fixture is the contract: if someone adds a client variant to the
    // adapter without adding it here, parity stops meaning anything.
    const covered = new Set<string>(ALL_CLIENT_STREAM_PARTS.map(part => String(part.type)));
    for (const type of [
      'text-start', 'text-delta', 'text-end', 'text-cancel',
      'tool-call', 'tool-result',
      'node-enter', 'node-exit',
      'flow-enter', 'flow-end', 'flow-transition',
      'handoff', 'interactive',
      'safety-blocked', 'pipeline-validation-block',
      'conversation-outcome', 'interrupted', 'paused',
      'custom', 'turn-end', 'done', 'error',
    ]) {
      expect(covered).toContain(type);
    }
  });
});
