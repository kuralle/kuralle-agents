import { describe, expect, it } from 'bun:test';
import { createEventBus, createTurnHandle } from '../../core/src/events/TurnHandle.js';
import {
  MemorySessionEventLog,
  MemoryStore,
  createRuntime,
  defineAgent,
  type LoggedEvent,
  type RunOptions,
  type Runtime,
  type StreamPart,
} from '@kuralle-agents/core';
import { createClient, reduce } from '../src/index.js';
import { sampleInterrupt } from './fixtures.js';
import {
  mockV3ReplyModel,
} from '../../core/test/helpers/mockLanguageModelV3Results.js';

async function collectEvents(iterable: AsyncIterable<LoggedEvent>): Promise<LoggedEvent[]> {
  const events: LoggedEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function donePart(sessionId: string): StreamPart {
  return { channel: 'client', type: 'done', payload: { sessionId } };
}

function stubRuntime(
  eventLog: MemorySessionEventLog,
  partsForInput: (input: string, signalDelivery?: RunOptions['signalDelivery']) => StreamPart[],
  opts?: { onCancel?: () => void },
): Runtime {
  const runtime: Pick<Runtime, 'run' | 'abortSession'> = {
    run(runOpts: RunOptions) {
      const sessionId = runOpts.sessionId ?? 'default';
      const input = typeof runOpts.input === 'string' ? runOpts.input : '';
      const parts = partsForInput(input, runOpts.signalDelivery);
      const bus = createEventBus();
      const runId = `run-${sessionId}`;
      const handle = createTurnHandle({
        run: async () => ({ text: '', toolResults: [], runId }),
        bus,
        runId: Promise.resolve(runId),
      });
      const originalCancel = handle.cancel.bind(handle);
      handle.cancel = (reason?: string) => {
        opts?.onCancel?.();
        originalCancel(reason);
      };
      void (async () => {
        for (const part of parts) {
          bus.emit(part);
          await eventLog.append(sessionId, [part], runId);
        }
        bus.close();
      })();
      return handle;
    },
    abortSession(_sessionId: string, _reason?: string) {
      opts?.onCancel?.();
    },
  };
  return runtime as Runtime;
}

function wiredHarness(reply = 'Hello.') {
  const eventLog = new MemorySessionEventLog();
  const runtime = createRuntime({
    eventLog,
    agents: [defineAgent({ id: 'a', instructions: 'help', model: mockV3ReplyModel(reply) })],
    defaultAgentId: 'a',
    sessionStore: new MemoryStore(),
  });
  const client = createClient({ kind: 'local', runtime, eventLog });
  return { eventLog, runtime, client };
}

describe('Session local transport', () => {
  it('send drains through TurnResponse and completes', async () => {
    const eventLog = new MemorySessionEventLog();
    const runtime = stubRuntime(eventLog, () => [
      { channel: 'client', type: 'text-start', payload: { id: 'a1' } },
      { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Sure.' } },
      { channel: 'client', type: 'text-end', payload: { id: 'a1' } },
      donePart('sess-send'),
    ]);
    const client = createClient({ kind: 'local', runtime, eventLog });
    const session = client.sessions.create();

    const turn = await session.send('hi');
    const events = await collectEvents(turn);
    await turn.result();

    expect(events.some((event) => event.part.type === 'done')).toBe(true);
    expect(events[0]?.index).toBe(0);
  });

  it('snapshot returns full history and tail cursor', async () => {
    const { client } = wiredHarness();
    const session = client.sessions.create();
    const turn = await session.send('one');
    await collectEvents(turn);
    await turn.result();

    const snap = await session.snapshot();
    expect(snap.events.length).toBeGreaterThan(0);
    expect(snap.cursor.sessionId).toBe(session.id);
    expect(snap.cursor.index).toBe(snap.events[snap.events.length - 1]!.index);
  });

  it('stream with follow yields live events', async () => {
    const { client } = wiredHarness();
    const session = client.sessions.create();
    const controller = new AbortController();

    const follower = collectEvents(
      session.stream({ startIndex: 0, follow: true, signal: controller.signal }),
    );
    const turn = await session.send('stream me');
    const streamed = await collectEvents(turn);
    await turn.result();
    controller.abort();
    const followed = await follower;

    expect(followed.map((event) => event.eventId)).toEqual(streamed.map((event) => event.eventId));
  });

  it('cancel aborts the active turn handle', async () => {
    let cancelled = false;
    const eventLog = new MemorySessionEventLog();
    const runtime = stubRuntime(
      eventLog,
      () => [{ channel: 'client', type: 'text-start', payload: { id: 'a1' } }],
      { onCancel: () => { cancelled = true; } },
    );
    const client = createClient({ kind: 'local', runtime, eventLog });
    const session = client.sessions.create();

    await session.send('wait');
    await session.cancel('user stopped');
    expect(cancelled).toBe(true);
  });

  it('attach at a cursor yields only events after it', async () => {
    const eventLog = new MemorySessionEventLog();
    const runtime = stubRuntime(eventLog, (input) => [
      { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: input } },
      donePart('sess-cursor'),
    ]);
    const client = createClient({ kind: 'local', runtime, eventLog });
    const session = client.sessions.create();

    const turn1 = await session.send('one');
    await collectEvents(turn1);
    await turn1.result();
    const afterFirst = await session.snapshot();
    const cursor = afterFirst.cursor;

    const attached = client.sessions.attach(session.id, cursor);
    const turn2 = await session.send('two');
    await collectEvents(turn2);
    await turn2.result();

    const attachedEvents = await collectEvents(attached.stream());
    expect(attachedEvents.every((event) => event.index > cursor.index)).toBe(true);
    expect(attachedEvents.some((event) => event.part.type === 'done')).toBe(true);
    expect(attachedEvents.some((event) => event.index <= cursor.index)).toBe(false);
  });

  it('two concurrent stream() calls yield identical (index, eventId) sequences', async () => {
    const { client } = wiredHarness();
    const session = client.sessions.create();
    const controller = new AbortController();

    const streamA = collectEvents(
      session.stream({ startIndex: 0, follow: true, signal: controller.signal }),
    );
    const streamB = collectEvents(
      session.stream({ startIndex: 0, follow: true, signal: controller.signal }),
    );

    const turn = await session.send('parallel');
    await collectEvents(turn);
    await turn.result();
    controller.abort();

    const [a, b] = await Promise.all([streamA, streamB]);
    expect(a.map((event) => [event.index, event.eventId])).toEqual(
      b.map((event) => [event.index, event.eventId]),
    );
  });

  it('completes needsApproval through respond() using TurnView.pending requestId', async () => {
    const eventLog = new MemorySessionEventLog();
    const runtime = stubRuntime(eventLog, (_input, signalDelivery) => {
      if (signalDelivery) {
        return [
          { channel: 'client', type: 'text-start', payload: { id: 'a1' } },
          { channel: 'client', type: 'text-delta', payload: { id: 'a1', delta: 'Approved.' } },
          { channel: 'client', type: 'text-end', payload: { id: 'a1' } },
          donePart('approval-sess'),
        ];
      }
      return [
        {
          channel: 'internal',
          type: 'paused',
          payload: { waitingFor: 'approval', interrupt: sampleInterrupt },
        },
      ];
    });
    const client = createClient({ kind: 'local', runtime, eventLog });
    const session = client.sessions.create();

    const paused = await session.send('go');
    const pauseEvents = await collectEvents(paused);
    await paused.result();
    const view = reduce(pauseEvents);
    expect(view.status).toBe('input-required');
    expect(view.pending[0]?.requestId).toBe(sampleInterrupt.requestId);

    const resumed = await session.respond([
      { requestId: view.pending[0]!.requestId, decision: 'approve' },
    ]);
    const resumeEvents = await collectEvents(resumed);
    await resumed.result();
    const completed = reduce(resumeEvents);
    expect(completed.status).toBe('completed');
  });

  it('http and cloudflare targets create hosted clients', () => {
    expect(() => createClient({ kind: 'http', url: 'http://localhost' })).not.toThrow();
    expect(() =>
      createClient({ kind: 'cloudflare', url: 'http://localhost', agentName: 'a' }),
    ).not.toThrow();
  });
});
