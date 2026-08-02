/**
 * What Cloudflare's parser DOES with our wire, not just what we emit.
 *
 * `packages/core/test/core-ai-sdk/wire-parity.test.ts` pins the frames
 * `harnessToUIMessageStream` writes. Nothing pinned what happens to them on the
 * other side of the DO. That gap is why deleting `StreamAdapter` was verified by
 * deploying a Worker and reading a reply back — an expensive, slow check of a
 * contract that is really just a pure function.
 *
 * `applyChunkToParts` IS that function. `@cloudflare/ai-chat` imports it from
 * `agents/chat` and calls it per frame in `_streamSSEReply`, so running our
 * frames through it here exercises the same code a deployed DO runs, minus the
 * network. Deterministic, in-process, and it fails loudly if a future `agents`
 * release changes how it treats our parts.
 *
 * The property that matters: the parts the deleted adapter silently dropped —
 * HITL, safety, handoff, outcome — must survive into the assistant message.
 */

import { describe, expect, it } from 'bun:test';
import { applyChunkToParts } from 'agents/chat';
import { createUIMessageStreamResponse } from 'ai';
import {
  asStreamPartSource,
  drainSSEFrames,
  harnessToUIMessageStream,
} from '@kuralle-agents/core/testing';

/** Drive the canonical stream through the CF parser exactly as `_reply` does. */
async function replayThroughCloudflareParser(): Promise<{
  parts: Array<Record<string, unknown>>;
  unhandled: string[];
}> {
  const response = createUIMessageStreamResponse({
    stream: harnessToUIMessageStream(asStreamPartSource(), { sessionId: 's1' }),
  });
  const frames = await drainSSEFrames(response.body!);

  const parts: Array<Record<string, unknown>> = [];
  const unhandled: string[] = [];
  for (const frame of frames) {
    // `_streamSSEReply` treats a `false` return as "not a message part" and
    // falls through to its own switch for `start` / `finish` / `error`.
    if (!applyChunkToParts(parts as never, frame as never)) {
      unhandled.push(String(frame.type));
    }
  }
  return { parts, unhandled };
}

describe('Cloudflare parses the canonical Kuralle wire', () => {
  it('keeps the parts the deleted adapter silently dropped', async () => {
    const { parts } = await replayThroughCloudflareParser();
    const types = parts.map(part => String(part.type));

    // Every one of these had no case in the old `convertToSSELines` switch and
    // fell through to `break`, so an approval or a safety block was
    // structurally unreportable on Cloudflare.
    expect(types).toContain('data-kuralle-interactive');
    expect(types).toContain('data-kuralle-safety');
    expect(types).toContain('data-kuralle-handoff');
    expect(types).toContain('data-kuralle-outcome');
  });

  it('drops transient parts from history rather than persisting them', async () => {
    const { parts } = await replayThroughCloudflareParser();
    const types = parts.map(part => String(part.type));

    // `applyChunkToParts` returns early on `transient: true`, so these are
    // observed live (broadcast verbatim to connected clients, and via `onData`
    // in the browser) but never retained in the assistant message. Their
    // ABSENCE here is the correct behaviour — asserting the opposite is the
    // mistake that made the agent-builder events panel render nothing.
    expect(types).not.toContain('data-kuralle-node');
    expect(types).not.toContain('data-kuralle-flow');
    expect(types).not.toContain('data-kuralle-control');
    expect(types).not.toContain('data-kuralle-custom');
  });

  it('never persists a part under the deleted adapter\'s namespace', async () => {
    const { parts } = await replayThroughCloudflareParser();

    for (const part of parts) {
      const type = String(part.type);
      if (!type.startsWith('data-')) continue;
      // `data-handoff`, `data-flow-enter`, `data-error` — a client typed
      // against `KuralleUIMessage` matches none of them.
      expect(type.startsWith('data-kuralle-')).toBe(true);
    }
  });

  it('assembles streamed text into a single done text part', async () => {
    const { parts } = await replayThroughCloudflareParser();
    const text = parts.filter(part => part.type === 'text');

    expect(text.length).toBeGreaterThan(0);
    expect(text.map(part => part.text).join('')).toContain('Hello');
  });

  it('reconstructs the tool call with its arguments intact', async () => {
    const { parts } = await replayThroughCloudflareParser();
    const tool = parts.find(part => String(part.type).startsWith('tool-'));

    // The old adapter defaulted `includeToolArgs: false`, so tool arguments
    // were dropped on Cloudflare and present everywhere else.
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ toolName: 'lookup_order', input: { id: 'KX-4417' } });
  });

  it('reconciles a re-emitted turn in place instead of duplicating its parts', async () => {
    // Cloudflare's chat recovery re-runs `onChatMessage` after an interrupted
    // turn and appends to the SAME assistant message
    // (`_createStreamingAssistantMessage(continuation)` clones the last one).
    // With a random id per part, every handoff, safety block and outcome the
    // first attempt recorded is appended a second time.
    const parts: Array<Record<string, unknown>> = [];
    const apply = async () => {
      const response = createUIMessageStreamResponse({
        stream: harnessToUIMessageStream(asStreamPartSource(), { sessionId: 's1' }),
      });
      for (const frame of await drainSSEFrames(response.body!)) {
        applyChunkToParts(parts as never, frame as never);
      }
    };

    await apply();
    const first = parts.filter(part => String(part.type).startsWith('data-')).length;
    await apply();
    const second = parts.filter(part => String(part.type).startsWith('data-')).length;

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it('leaves start/finish/error for the caller instead of swallowing them', async () => {
    const { unhandled } = await replayThroughCloudflareParser();

    // These return `false`, which is how `_streamSSEReply` knows to apply
    // `messageMetadata` (carrying our sessionId) and to route an error to
    // `_broadcastChatMessage` as a real error rather than as content.
    expect(unhandled).toContain('start');
    expect(unhandled).toContain('error');
  });
});
