/**
 * Cloudflare must put the same frames on the wire as every other runtime.
 *
 * `StreamAdapter.ts` used to re-implement the mapping core already owns, and it
 * drifted: differently-named data parts, no `start`/`finish` framing,
 * `data-error` instead of a real error frame, text frames stripped of their
 * `id`, and — the sharp one — `interactive`, `safety-blocked`,
 * `pipeline-validation-block`, `conversation-outcome`, `paused` and
 * `interrupted` dropped entirely. Measured before deletion: the reference
 * emitted 103 frames where cf-agent emitted 7.
 *
 * Those dropped parts are the HITL-approval and safety-block reports. This
 * project's rule is to enforce safety structurally rather than by prompt,
 * because structural properties hold. A block enforced in the engine and lost
 * at the wire is not a reported block.
 *
 * `KuralleAgent` now delegates to `harnessToUIMessageStream`, so this file
 * guards the two things that would let the drift return: a second serialiser
 * reappearing on the public surface, and the mapping losing those parts.
 */

import { describe, expect, it } from 'bun:test';
import {
  asStreamPartSource,
  drainSSEFrames,
  harnessToUIMessageStream,
} from '@kuralle-agents/core/testing';
import { createUIMessageStreamResponse } from 'ai';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function canonicalFrames(): Promise<Array<Record<string, unknown>>> {
  const response = createUIMessageStreamResponse({
    stream: harnessToUIMessageStream(asStreamPartSource(), { sessionId: 's1' }),
  });
  return drainSSEFrames(response.body!);
}

describe('cf-agent emits the canonical UIMessageStream wire', () => {
  it('exposes no second serialiser to drift from', async () => {
    // Checked as source text, not by import: cf-agent's index pulls in `agents`,
    // which needs the workerd runtime and cannot load in a plain test.
    // The whole defect was a parallel implementation — if one is exported
    // again, this fails before it has a chance to diverge.
    const root = join(import.meta.dirname, '..', 'src');
    const index = await readFile(join(root, 'index.ts'), 'utf8');
    for (const symbol of ['createSSEResponse', 'convertToSSELines', 'DEFAULT_STREAM_CONFIG', 'StreamAdapterConfig']) {
      expect(index).not.toContain(symbol);
    }
    await expect(readFile(join(root, 'StreamAdapter.ts'), 'utf8')).rejects.toThrow();

    // And the streaming path delegates to the one mapping core owns.
    const agent = await readFile(join(root, 'KuralleAgent.ts'), 'utf8');
    expect(agent).toContain('harnessToUIMessageStream');
  });

  it('reports HITL and safety parts to the client', async () => {
    const types = (await canonicalFrames()).map(frame => String(frame.type));

    // Each of these was structurally unreportable on Cloudflare before.
    expect(types).toContain('data-kuralle-interactive');
    expect(types).toContain('data-kuralle-safety');
    expect(types).toContain('data-kuralle-outcome');
    expect(types).toContain('data-kuralle-control');
  });

  it('names data parts so a KuralleUIMessage-typed client matches them', async () => {
    const dataTypes = (await canonicalFrames())
      .map(frame => String(frame.type))
      .filter(type => type.startsWith('data-'));

    // `data-handoff` compiles against a loose client and silently matches
    // nothing against a typed one — the worst of both.
    expect(dataTypes.length).toBeGreaterThan(0);
    for (const type of dataTypes) {
      expect(type.startsWith('data-kuralle-')).toBe(true);
    }
  });

  it('keeps text ids so interleaved segments stay separable', async () => {
    const start = (await canonicalFrames()).find(frame => frame.type === 'text-start');
    expect(start?.id).toBe('t1');
  });

  it('surfaces errors as real error frames and carries session metadata', async () => {
    const types = (await canonicalFrames()).map(frame => String(frame.type));
    expect(types).toContain('error');
    expect(types).not.toContain('data-error');
    // `start` carries sessionId in messageMetadata; cf-agent emitted no
    // framing at all. No `finish` here because the fixture ends in an error,
    // which terminates the stream — an errored stream does not finish.
    expect(types).toContain('start');
  });
});
