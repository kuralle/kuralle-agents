import { describe, expect, it } from 'bun:test';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import {
  speakGated,
  type GateOutcome,
  type TokenSource,
} from '../../src/runtime/channels/streaming/speakGated.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import {
  makeRunState,
  makeTestSession,
  stubModel,
} from '../core-durable/helpers.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';

function tokenSource(deltas: string[]): TokenSource {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) {
        yield { delta };
      }
    },
  };
}

function throwingSource(after: string[], error: Error): TokenSource {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of after) {
        yield { delta };
      }
      throw error;
    },
  };
}

async function captureSpeakGated(args: {
  mode: 'token' | 'sentence' | 'turn';
  deltas: string[];
  runGate: (text: string, final: boolean) => Promise<GateOutcome>;
  turnId?: string;
}): Promise<{ parts: HarnessStreamPart[]; result: Awaited<ReturnType<typeof speakGated>> }> {
  const parts: HarnessStreamPart[] = [];
  const session = makeTestSession('speakgated-test');
  const memoryStore = new MemoryStore();
  await memoryStore.save(session);
  const runStore = new SessionRunStore(memoryStore, session.id);
  const runState = makeRunState(session.id, 'speakgated-run');
  await runStore.initRun(runState);
  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: (part) => parts.push(part),
  });
  const turnId = args.turnId ?? 'turn-1';
  const result = await speakGated({
    ctx,
    mode: args.mode,
    turnId,
    source: tokenSource(args.deltas),
    runGate: args.runGate,
  });
  return { parts, result };
}

function textDeltas(parts: HarnessStreamPart[]): string[] {
  return parts
    .filter((p): p is Extract<HarnessStreamPart, { type: 'text-delta' }> => p.type === 'text-delta')
    .map((p) => p.delta);
}

function lifecycleCounts(parts: HarnessStreamPart[], id: string) {
  return {
    starts: parts.filter((p) => p.type === 'text-start' && p.id === id).length,
    ends: parts.filter((p) => p.type === 'text-end' && p.id === id).length,
  };
}

const allow: GateOutcome = { blocked: false, text: '' };

describe('speakGated modes', () => {
  it('token mode: N deltas in ⇒ N text-delta out, one start/end, shared turn id', async () => {
    const { parts } = await captureSpeakGated({
      mode: 'token',
      deltas: ['Hel', 'lo', ' world'],
      runGate: async (text) => ({ ...allow, text }),
    });
    expect(textDeltas(parts)).toEqual(['Hel', 'lo', ' world']);
    const { starts, ends } = lifecycleCounts(parts, 'turn-1');
    expect(starts).toBe(1);
    expect(ends).toBe(1);
    expect(parts.filter((p) => p.type === 'text-delta').every((p) => p.id === 'turn-1')).toBe(true);
  });

  it('turn mode: buffers until end then emits one lifecycle message', async () => {
    const { parts, result } = await captureSpeakGated({
      mode: 'turn',
      deltas: ['One ', 'two ', 'three.'],
      runGate: async (text, final) => {
        expect(final).toBe(true);
        return { blocked: false, text };
      },
    });
    expect(textDeltas(parts)).toEqual(['One two three.']);
    expect(lifecycleCounts(parts, 'turn-1')).toEqual({ starts: 1, ends: 1 });
    expect(result.text).toBe('One two three.');
    const midStream = parts.filter((p) => p.type === 'text-delta');
    expect(midStream.length).toBe(1);
  });

  it('turn mode block: only safe message emitted, no streamed partials', async () => {
    const safe = 'Policy blocked this reply.';
    const { parts, result } = await captureSpeakGated({
      mode: 'turn',
      deltas: ['Secret ', 'leak ', 'content.'],
      runGate: async () => ({
        blocked: true,
        text: safe,
        reason: 'policy',
      }),
    });
    expect(textDeltas(parts)).toEqual([safe]);
    expect(result.text).toBe(safe);
    expect(parts.some((p) => p.type === 'text-cancel')).toBe(false);
    expect(textDeltas(parts).join('')).not.toContain('Secret');
  });

  it('sentence mode cleared: each sentence is its own text-delta with one start/end', async () => {
    const { parts, result } = await captureSpeakGated({
      mode: 'sentence',
      deltas: ['Hi there. How are you?'],
      runGate: async (text) => ({ blocked: false, text }),
    });
    expect(textDeltas(parts)).toEqual(['Hi there.', ' How are you?']);
    expect(lifecycleCounts(parts, 'turn-1')).toEqual({ starts: 1, ends: 1 });
    expect(result.text).toBe('Hi there. How are you?');
    expect(textDeltas(parts).join('')).toBe('Hi there. How are you?');
  });

  it('sentence BLOCKED: first sentence emitted; blocked sentence absent; cancel then fresh safe lifecycle', async () => {
    const blockedSentence = 'This must never leak.';
    const safe = 'Sorry, I cannot continue.';
    const { parts, result } = await captureSpeakGated({
      mode: 'sentence',
      deltas: ['Hello world. ', blockedSentence],
      runGate: async (text) => {
        if (text === blockedSentence) {
          return { blocked: true, text: safe, reason: 'policy-block' };
        }
        return { blocked: false, text };
      },
    });

    const deltas = textDeltas(parts);
    expect(deltas).toContain('Hello world.');
    expect(deltas).not.toContain(blockedSentence);
    expect(deltas.some((d) => d.includes(blockedSentence))).toBe(false);
    expect(result.text).toBe(safe);

    const cancelIdx = parts.findIndex(
      (p) => p.type === 'text-cancel' && p.id === 'turn-1' && p.reason === 'policy-block',
    );
    expect(cancelIdx).toBeGreaterThanOrEqual(0);

    const safeStartIdx = parts.findIndex(
      (p) => p.type === 'text-start' && p.id !== 'turn-1',
    );
    expect(safeStartIdx).toBeGreaterThan(cancelIdx);
    const safeId = (parts[safeStartIdx] as { id: string }).id;
    expect(deltas).toContain(safe);
    expect(lifecycleCounts(parts, 'turn-1')).toEqual({ starts: 1, ends: 0 });
    expect(lifecycleCounts(parts, safeId)).toEqual({ starts: 1, ends: 1 });
  });

  it('REQ-7: exactly one text-start and one text-end for the turn id on a cleared sentence stream', async () => {
    const { parts } = await captureSpeakGated({
      mode: 'sentence',
      deltas: ['First. Second.'],
      runGate: async (text) => ({ blocked: false, text }),
    });
    expect(lifecycleCounts(parts, 'turn-1')).toEqual({ starts: 1, ends: 1 });
  });

  it('source error: emits error and text-cancel when lifecycle was started', async () => {
    const parts: HarnessStreamPart[] = [];
    const session = makeTestSession('speakgated-err');
    const memoryStore = new MemoryStore();
    await memoryStore.save(session);
    const runStore = new SessionRunStore(memoryStore, session.id);
    const runState = makeRunState(session.id, 'speakgated-err-run');
    await runStore.initRun(runState);
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    await expect(
      speakGated({
        ctx,
        mode: 'token',
        turnId: 'turn-err',
        source: throwingSource(['partial'], new Error('boom')),
        runGate: async (text) => ({ blocked: false, text }),
      }),
    ).rejects.toThrow('boom');

    expect(parts.some((p) => p.type === 'error' && p.error === 'boom')).toBe(true);
    expect(
      parts.some((p) => p.type === 'text-cancel' && p.id === 'turn-err' && p.reason === 'boom'),
    ).toBe(true);
    expect(lifecycleCounts(parts, 'turn-err').starts).toBe(1);
    expect(lifecycleCounts(parts, 'turn-err').ends).toBe(0);
  });
});
