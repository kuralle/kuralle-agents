import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { MemorySessionEventLog } from '../src/events/SessionEventLog.js';
import { scrubSecrets } from '../src/events/scrubSecrets.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import type { ChannelDriver } from '../src/types/channel.js';
import type { StreamPart } from '../src/types/stream.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';
import { mockV3StreamResult } from './helpers/mockLanguageModelV3Results.js';

function turnEnd(): StreamPart {
  return { channel: 'internal', type: 'turn-end', payload: {} };
}

function conversationalDriver(reply = 'ok'): ChannelDriver {
  return {
    async runAgentTurn() {
      return { text: reply, toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

async function drainTurn(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  input: string,
) {
  const handle = runtime.run({
    sessionId,
    input,
    userId: 'user-1',
    driver: conversationalDriver(input),
  });
  for await (const _part of handle.events) {
    // drain
  }
  await handle;
  await runtime.settled();
}

describe('SessionEventLog', () => {
  it('keeps gapless indices across three turns', async () => {
    const eventLog = new MemorySessionEventLog();
    const model = new MockLanguageModelV3({
      doStream: async () => mockV3StreamResult('Sure.'),
    });
    const runtime = createRuntime({
      eventLog,
      agents: [defineAgent({ id: 'a', instructions: 'help', model })],
      defaultAgentId: 'a',
      sessionStore: new MemoryStore(),
    });

    await drainTurn(runtime, 'gapless-sess', 'one');
    await drainTurn(runtime, 'gapless-sess', 'two');
    await drainTurn(runtime, 'gapless-sess', 'three');

    const { events } = await eventLog.read('gapless-sess', 0);
    const indices = events.map((event) => event.index);
    for (let index = 1; index < indices.length; index += 1) {
      expect(indices[index]! - indices[index - 1]!).toBe(1);
    }
    expect(indices[0]).toBe(0);
    expect(await eventLog.tail('gapless-sess')).toBe(indices[indices.length - 1]);
  });

  it('returns bounded catch-up with the right next cursor', async () => {
    const eventLog = new MemorySessionEventLog();
    const model = new MockLanguageModelV3({
      doStream: async () => mockV3StreamResult('Sure.'),
    });
    const runtime = createRuntime({
      eventLog,
      agents: [defineAgent({ id: 'a', instructions: 'help', model })],
      defaultAgentId: 'a',
      sessionStore: new MemoryStore(),
    });

    await drainTurn(runtime, 'read-sess', 'hello');

    const all = await eventLog.read('read-sess', 0);
    expect(all.events.length).toBeGreaterThanOrEqual(2);

    const first = await eventLog.read('read-sess', 0, 1);
    expect(first.events.length).toBe(1);
    expect(first.next).toBe(first.events[0]!.index + 1);

    const second = await eventLog.read('read-sess', first.next);
    expect(second.events[0]!.index).toBe(first.next);
  });

  it('resumes follow from a cursor without duplicate eventId', async () => {
    const eventLog = new MemorySessionEventLog();
    const model = new MockLanguageModelV3({
      doStream: async () => mockV3StreamResult('Sure.'),
    });
    const runtime = createRuntime({
      eventLog,
      agents: [defineAgent({ id: 'a', instructions: 'help', model })],
      defaultAgentId: 'a',
      sessionStore: new MemoryStore(),
    });

    const controller = new AbortController();
    const follower = (async () => {
      const seen = new Set<string>();
      const collected = [];
      for await (const event of eventLog.follow('follow-sess', 0, controller.signal)) {
        expect(seen.has(event.eventId)).toBe(false);
        seen.add(event.eventId);
        collected.push(event);
        if (event.part.type === 'done') {
          controller.abort();
          break;
        }
      }
      return collected;
    })();

    await drainTurn(runtime, 'follow-sess', 'hello');
    const firstPass = await follower;

    const resumed = await eventLog.read(
      'follow-sess',
      firstPass[firstPass.length - 1]!.index + 1,
    );
    expect(resumed.events).toEqual([]);
  });

  it('truncates from the head and surfaces a log-truncated marker for dropped indices', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 4 });
    await eventLog.append('ceil-sess', [turnEnd()], 'r1');
    await eventLog.append('ceil-sess', [turnEnd()], 'r1');
    await eventLog.append('ceil-sess', [turnEnd()], 'r1');
    await eventLog.append('ceil-sess', [turnEnd()], 'r1');
    await eventLog.append('ceil-sess', [turnEnd()], 'r1');

    const fromGap = await eventLog.read('ceil-sess', 0, 1);
    expect(fromGap.events.some((event) => event.part.type === 'log-truncated')).toBe(true);
    expect(fromGap.next).toBeGreaterThan(0);

    const retained = await eventLog.read('ceil-sess', fromGap.next);
    expect(retained.events.every((event) => event.index >= fromGap.next)).toBe(true);
    expect(await eventLog.tail('ceil-sess')).toBe(retained.events[retained.events.length - 1]?.index ?? -1);
  });

  it('fix 1: double truncation merges dropped ranges so read(from) always returns a covering marker', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 4 });
    for (let index = 0; index < 12; index += 1) {
      await eventLog.append('double-trunc', [turnEnd()], 'r1');
    }

    const tail = await eventLog.tail('double-trunc');
    expect(tail).toBe(11);

    for (let from = 0; from < tail; from += 1) {
      const { events, next } = await eventLog.read('double-trunc', from, 1);
      expect(events.length).toBe(1);
      const event = events[0]!;
      if (event.part.type === 'log-truncated') {
        expect(event.index).toBe(Math.max(event.part.payload.fromIndex, from));
        if (event.index !== from) {
          expect(from).toBeGreaterThanOrEqual(event.part.payload.fromIndex);
          expect(from).toBeLessThanOrEqual(event.part.payload.toIndex);
        }
        expect(event.part.payload.fromIndex).toBeLessThanOrEqual(event.part.payload.toIndex);
        if (event.index < event.part.payload.toIndex) {
          expect(next).toBe(event.part.payload.toIndex + 1);
        } else {
          expect(next).toBe(event.index + 1);
        }
      } else {
        expect(event.index).toBe(from);
        expect(next).toBe(from + 1);
      }
    }
  });

  it('fix 2: follow delivers retained events when truncation happens mid-iteration', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 5 });
    for (let index = 0; index < 4; index += 1) {
      await eventLog.append('follow-trunc', [turnEnd()], 'r1');
    }

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const controller = new AbortController();
    const delivered: number[] = [];
    const followTask = (async () => {
      for await (const event of eventLog.follow('follow-trunc', 0, controller.signal)) {
        delivered.push(event.index);
        if (event.index === 0) {
          await hold;
        }
      }
    })();

    await eventLog.append('follow-trunc', [turnEnd()], 'r1');
    await eventLog.append('follow-trunc', [turnEnd()], 'r1');
    await eventLog.append('follow-trunc', [turnEnd()], 'r1');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await followTask;

    expect(delivered).toContain(2);

    const { events } = await eventLog.read('follow-trunc', 0);
    const retained = events.filter((event) => event.part.type !== 'log-truncated');
    for (const event of retained) {
      expect(delivered).toContain(event.index);
    }
  });

  it('fix 2: follow delivers strictly increasing indices under concurrent truncation', async () => {
    const part = (n: number): StreamPart => ({
      channel: 'client',
      type: 'text-delta',
      payload: { id: 'a', delta: `d${n}` },
    });
    const eventLog = new MemorySessionEventLog({ maxEvents: 12 });
    const controller = new AbortController();
    const delivered: Array<{ index: number; type: string }> = [];

    const consumer = (async () => {
      for await (const event of eventLog.follow('order-sess', 0, controller.signal)) {
        delivered.push({ index: event.index, type: event.part.type });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    for (let index = 0; index < 30; index += 1) {
      await eventLog.append('order-sess', [part(index)], 'r1');
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort();
    await consumer.catch(() => {});

    const indices = delivered.map((entry) => entry.index);
    const nonIncreasing = indices.filter((value, index) => index > 0 && value <= indices[index - 1]!);
    expect(nonIncreasing).toEqual([]);

    let cursor = 0;
    for (const entry of delivered) {
      if (entry.type === 'log-truncated') {
        const { events } = await eventLog.read('order-sess', cursor, 1);
        const readMarker = events[0];
        expect(readMarker?.part.type).toBe('log-truncated');
        if (readMarker?.part.type === 'log-truncated') {
          expect(entry.index).toBe(Math.max(readMarker.part.payload.fromIndex, cursor));
          expect(cursor).toBeGreaterThanOrEqual(readMarker.part.payload.fromIndex);
          expect(cursor).toBeLessThanOrEqual(readMarker.part.payload.toIndex);
          cursor = readMarker.part.payload.toIndex + 1;
        }
        continue;
      }
      expect(entry.index).toBeGreaterThanOrEqual(cursor);
      cursor = entry.index + 1;
    }
  });

  it('fix 2: read returns strictly increasing indices with gap markers at fromIndex', async () => {
    const part = (n: number): StreamPart => ({
      channel: 'client',
      type: 'text-delta',
      payload: { id: 'a', delta: `d${n}` },
    });
    const eventLog = new MemorySessionEventLog({ maxEvents: 12 });
    for (let index = 0; index < 30; index += 1) {
      await eventLog.append('read-order', [part(index)], 'r1');
    }

    const collected: Array<{ index: number; type: string }> = [];
    let cursor = 0;
    while (cursor <= (await eventLog.tail('read-order'))) {
      const { events, next } = await eventLog.read('read-order', cursor, 5);
      if (events.length === 0) break;
      for (const event of events) {
        collected.push({ index: event.index, type: event.part.type });
      }
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }

    const indices = collected.map((entry) => entry.index);
    const nonIncreasing = indices.filter((value, index) => index > 0 && value <= indices[index - 1]!);
    expect(nonIncreasing).toEqual([]);

    for (const entry of collected) {
      if (entry.type !== 'log-truncated') continue;
      const { events } = await eventLog.read('read-order', entry.index, 1);
      const marker = events[0];
      expect(marker?.part.type).toBe('log-truncated');
      if (marker?.part.type === 'log-truncated') {
        expect(entry.index).toBeGreaterThanOrEqual(marker.part.payload.fromIndex);
        expect(entry.index).toBeLessThanOrEqual(marker.part.payload.toIndex);
      }
    }
  });

  it('fix 3: unserializable parts become poison markers without wedging later appends', async () => {
    const eventLog = new MemorySessionEventLog();
    const bigintPart = {
      channel: 'internal' as const,
      type: 'tool-result' as const,
      payload: { toolName: 't', toolCallId: 'c', result: { n: 1n } },
    };

    await eventLog.append('poison-sess', [bigintPart], 'r1');
    await eventLog.append('poison-sess', [turnEnd()], 'r1');
    await eventLog.append('poison-sess', [turnEnd()], 'r1');
    await eventLog.append('poison-sess', [turnEnd()], 'r1');

    expect(await eventLog.tail('poison-sess')).toBe(3);

    const { events } = await eventLog.read('poison-sess', 0);
    expect(events.length).toBe(4);
    expect(events[0]!.part.type).toBe('custom');
    if (events[0]!.part.type === 'custom') {
      expect(events[0]!.part.payload.name).toBe('log-poison');
    }
    expect(events.slice(1).every((event) => event.part.type === 'turn-end')).toBe(true);
  });

  it('fix 5: scrub-only write path keeps error diagnostics without sanitizePart', async () => {
    const eventLog = new MemorySessionEventLog();
    const urlError = scrubSecrets({
      channel: 'client',
      type: 'error',
      payload: { error: 'fetch failed: https://user:pw@host ECONNRESET at gateway' },
    });
    const plainError = scrubSecrets({
      channel: 'client',
      type: 'error',
      payload: { error: 'fetch failed: ECONNRESET at gateway' },
    });
    await eventLog.append('error-sess', [urlError, plainError], 'r1');

    const { events } = await eventLog.read('error-sess', 0);
    expect(events.length).toBe(2);
    for (const event of events) {
      expect(event.part.type).toBe('error');
      if (event.part.type !== 'error') continue;
      expect(event.part.payload.error).not.toBe('An error occurred. Please try again.');
    }
    expect(JSON.stringify(events)).not.toContain('user:pw@');
    expect(events[1]!.part.type === 'error' && events[1]!.part.payload.error).toBe(
      'fetch failed: ECONNRESET at gateway',
    );
  });

  it('fix 6: batched truncation keeps markers a small fraction of retained records at steady state', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 8 });
    for (let index = 0; index < 40; index += 1) {
      await eventLog.append('batch-sess', [turnEnd()], 'r1');
    }

    const { events } = await eventLog.read('batch-sess', 0, 100);
    const markers = events.filter((event) => event.part.type === 'log-truncated');
    const realEvents = events.filter((event) => event.part.type !== 'log-truncated');
    expect(realEvents.length).toBeGreaterThan(0);
    expect(markers.length).toBeLessThanOrEqual(1);
    expect(markers.length / events.length).toBeLessThanOrEqual(0.25);
  });

  it('fix 7: rejects degenerate ceiling config in the constructor', () => {
    expect(() => new MemorySessionEventLog({ maxEvents: 0 })).toThrow(RangeError);
    expect(() => new MemorySessionEventLog({ maxBytes: 64 })).toThrow(RangeError);
  });

  it('t2: worst allowed config completes without hanging', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 1, maxBytes: 256 });
    await eventLog.append('worst-sess', [turnEnd()], 'r1');
    await eventLog.append('worst-sess', [turnEnd()], 'r1');
    expect(await eventLog.tail('worst-sess')).toBeGreaterThan(0);
  });

  it('t2: repeated truncation delivers every retained event exactly once via forward walk', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 6 });
    for (let index = 0; index < 30; index += 1) {
      await eventLog.append('walk-sess', [turnEnd()], 'r1');
    }

    const tail = await eventLog.tail('walk-sess');
    const delivered = new Set<number>();
    let cursor = 0;
    while (cursor <= tail) {
      const { events, next } = await eventLog.read('walk-sess', cursor, 1);
      expect(events.length).toBe(1);
      const event = events[0]!;
      if (event.part.type === 'log-truncated') {
        expect(event.part.payload.fromIndex).toBeLessThan(event.part.payload.toIndex + 1);
        cursor = next;
        continue;
      }
      expect(delivered.has(event.index)).toBe(false);
      delivered.add(event.index);
      cursor = next;
    }

    const { events: allRetained } = await eventLog.read('walk-sess', 0, Number.POSITIVE_INFINITY);
    const retainedIndices = allRetained
      .filter((event) => event.part.type !== 'log-truncated')
      .map((event) => event.index);
    expect(retainedIndices.length).toBe(delivered.size);
    for (const index of retainedIndices) {
      expect(delivered.has(index)).toBe(true);
    }
  });

  it('t2: marker ranges are never empty or inverted after one sweep and after many', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 4 });

    await eventLog.append('range-sess', [turnEnd()], 'r1');
    await eventLog.append('range-sess', [turnEnd()], 'r1');
    await eventLog.append('range-sess', [turnEnd()], 'r1');
    await eventLog.append('range-sess', [turnEnd()], 'r1');
    await eventLog.append('range-sess', [turnEnd()], 'r1');

    const afterOne = await eventLog.read('range-sess', 0, 1);
    const markerOne = afterOne.events[0];
    expect(markerOne?.part.type).toBe('log-truncated');
    if (markerOne?.part.type === 'log-truncated') {
      expect(markerOne.part.payload.fromIndex).toBeLessThanOrEqual(markerOne.part.payload.toIndex);
    }

    for (let index = 0; index < 20; index += 1) {
      await eventLog.append('range-sess', [turnEnd()], 'r1');
    }

    const tail = await eventLog.tail('range-sess');
    for (let from = 0; from < tail; from += 1) {
      const { events } = await eventLog.read('range-sess', from, 1);
      const event = events[0];
      if (event?.part.type !== 'log-truncated') continue;
      expect(event.part.payload.fromIndex).toBeLessThanOrEqual(event.part.payload.toIndex);
    }
  });

  it('t2: read and follow present the same dropped range for the same cursor', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 5 });
    for (let index = 0; index < 15; index += 1) {
      await eventLog.append('agree-sess', [turnEnd()], 'r1');
    }

    const tail = await eventLog.tail('agree-sess');
    for (let cursor = 0; cursor < tail; cursor += 1) {
      const readBatch = await eventLog.read('agree-sess', cursor, 1);
      expect(readBatch.events.length).toBe(1);
      const readEvent = readBatch.events[0]!;

      const controller = new AbortController();
      const followEvent = await (async () => {
        for await (const event of eventLog.follow('agree-sess', cursor, controller.signal)) {
          controller.abort();
          return event;
        }
        return undefined;
      })();

      expect(followEvent).toBeDefined();
      expect(followEvent!.index).toBe(readEvent.index);
      expect(followEvent!.eventId).toBe(readEvent.eventId);
      if (readEvent.part.type === 'log-truncated' && followEvent!.part.type === 'log-truncated') {
        expect(followEvent!.part.payload).toEqual(readEvent.part.payload);
      }
    }
  });

  it('t2: append stays O(1) amortised at 50k appends', async () => {
    const eventLog = new MemorySessionEventLog({ maxEvents: 100_000 });
    const start = performance.now();
    for (let index = 0; index < 50_000; index += 1) {
      await eventLog.append('perf-sess', [turnEnd()], 'r1');
    }
    const elapsed = performance.now() - start;
    console.log(`  50k appends: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(500);
  });

  it('fix 9: read with limit <= 0 returns no events', async () => {
    const eventLog = new MemorySessionEventLog();
    await eventLog.append('limit-sess', [turnEnd()], 'r1');

    expect(await eventLog.read('limit-sess', 0, 0)).toEqual({ events: [], next: 0 });
    expect(await eventLog.read('limit-sess', 0, -1)).toEqual({ events: [], next: 0 });
  });

  it('fix 10: delete removes session state and runtime deleteSession clears the log', async () => {
    const eventLog = new MemorySessionEventLog();
    const model = new MockLanguageModelV3({
      doStream: async () => mockV3StreamResult('Sure.'),
    });
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      eventLog,
      agents: [defineAgent({ id: 'a', instructions: 'help', model })],
      defaultAgentId: 'a',
      sessionStore,
    });

    await drainTurn(runtime, 'delete-sess', 'hello');
    expect(await eventLog.tail('delete-sess')).toBeGreaterThanOrEqual(0);

    await runtime.deleteSession('delete-sess');
    expect(await eventLog.tail('delete-sess')).toBe(-1);
    expect((await eventLog.read('delete-sess', 0)).events).toEqual([]);
  });
});

describe('serialization happens exactly once per event', () => {
  it('a payload whose toJSON succeeds then throws cannot wedge the log', async () => {
    // Found by adversarial review: three separate JSON.stringify calls let a stateful toJSON pass
    // the serializability check and throw on a later one. One serialization decides everything.
    let calls = 0;
    const treacherous = {
      toJSON() {
        calls += 1;
        if (calls > 1) throw new Error('toJSON is stateful');
        return { ok: true };
      },
    };
    const log = new MemorySessionEventLog();
    const delta = (d: string): StreamPart =>
      ({ channel: 'client', type: 'text-delta', payload: { id: 'a', delta: d } });
    await log.append('s', [delta('before')], 'r');
    await log.append(
      's',
      [{ channel: 'internal', type: 'tool-result', payload: { toolName: 't', result: treacherous } } as StreamPart],
      'r',
    );
    await log.append('s', [delta('after')], 'r');

    const { events } = await log.read('s', 0);
    expect(events.map((event) => event.index)).toEqual([0, 1, 2]);
    expect(await log.tail('s')).toBe(2);

    // The discriminating assertion: one successful serialization must be REUSED, not repeated.
    // A second JSON.stringify throws on the stateful toJSON and poisons a payload that was fine.
    const middle = events[1]!;
    expect(middle.part.type).toBe('tool-result');
    expect(calls).toBe(1);
  });
});
