import { describe, expect, it } from 'bun:test';
import {
  MemorySessionEventLog,
  type LoggedEvent,
  type StreamPart,
} from '../src/events/SessionEventLog.js';
import {
  cancelSession,
  readEvents,
  readMemory,
  readSnapshot,
  sessionRouteParsing,
  type SessionRouteDeps,
} from '../src/events/sessionRoutes.js';

function textDelta(delta: string): StreamPart {
  return { channel: 'client', type: 'text-delta', payload: { id: 't1', delta } };
}

function errorPart(message: string): StreamPart {
  return { channel: 'client', type: 'error', payload: { error: message } };
}

function turnEnd(): StreamPart {
  return { channel: 'internal', type: 'turn-end', payload: {} };
}

async function collectNdjson(source: AsyncIterable<LoggedEvent>): Promise<LoggedEvent[]> {
  const events: LoggedEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function baseDeps(eventLog: MemorySessionEventLog, overrides?: Partial<SessionRouteDeps>): SessionRouteDeps {
  return {
    eventLog,
    memory: {
      readBlocks: async () => [],
      readExtracted: async () => [],
    },
    cancelTurn: async () => 'no_active_turn',
    memoryOwner: (_p, userId) => userId,
    ...overrides,
  };
}

describe('session route handlers', () => {
  describe('query parsing semantics', () => {
    it('defaults limit to 100 when omitted', () => {
      expect(sessionRouteParsing.parseLimit(undefined)).toBe(100);
    });

    it('rejects empty limit string with null', () => {
      expect(sessionRouteParsing.parseLimit('')).toBeNull();
    });

    it('rejects non-integer and sub-1 limits', () => {
      expect(sessionRouteParsing.parseLimit('5.9')).toBeNull();
      expect(sessionRouteParsing.parseLimit('0')).toBeNull();
    });

    it('clamps limit to 1000', () => {
      expect(sessionRouteParsing.parseLimit('5000')).toBe(1000);
    });

    it('defaults from to 0 when omitted', () => {
      expect(sessionRouteParsing.parseFromIndex(undefined)).toBe(0);
    });

    it('rejects negative and non-integer from values', () => {
      expect(sessionRouteParsing.parseFromIndex('-1')).toBeNull();
      expect(sessionRouteParsing.parseFromIndex('1.5')).toBeNull();
      expect(sessionRouteParsing.parseFromIndex('')).toBeNull();
    });
  });

  describe('readSnapshot', () => {
    it('returns the most recent visible events (tail window)', async () => {
      const eventLog = new MemorySessionEventLog();
      const sessionId = 'tail-sess';
      for (let index = 0; index < 150; index += 1) {
        await eventLog.append(sessionId, [textDelta(`m${index}`)], 'run-1');
      }

      const outcome = await readSnapshot(
        baseDeps(eventLog),
        sessionId,
        { limit: '100' },
        'all',
      );
      expect(outcome.status).toBe(200);
      const body = outcome.body as { events: LoggedEvent[]; cursor: { sessionId: string; index: number } };
      expect(body.events).toHaveLength(100);
      expect(body.events[0]!.index).toBe(50);
      expect(body.events[99]!.index).toBe(149);
      expect(body.cursor).toEqual({ sessionId, index: 150 });
    });

    it('uses cursor index 0 for an empty session', async () => {
      const eventLog = new MemorySessionEventLog();
      const outcome = await readSnapshot(baseDeps(eventLog), 'empty', {}, 'all');
      const body = outcome.body as { events: LoggedEvent[]; cursor: { index: number } };
      expect(body.events).toEqual([]);
      expect(body.cursor.index).toBe(0);
    });

    it('returns 400 for malformed limit', async () => {
      const outcome = await readSnapshot(baseDeps(new MemorySessionEventLog()), 's', { limit: '' }, 'all');
      expect(outcome.status).toBe(400);
    });
  });

  describe('readEvents', () => {
    it('returns 400 for invalid from', async () => {
      const outcome = await readEvents(baseDeps(new MemorySessionEventLog()), 's', { from: '-1' }, 'all');
      expect(outcome.status).toBe(400);
    });

    it('sanitizes error parts on the safe filter', async () => {
      const eventLog = new MemorySessionEventLog();
      await eventLog.append('s', [errorPart('token=sk-live-secret')], 'r1');
      const outcome = await readEvents(baseDeps(eventLog), 's', { from: '0', follow: 'false' }, 'safe');
      const events = await collectNdjson(outcome.ndjson!);
      expect(events[0]!.part.type).toBe('error');
      if (events[0]!.part.type === 'error') {
        expect(events[0]!.part.payload.error).toBe('An error occurred. Please try again.');
      }
    });

    it('allows log-truncated markers through the safe filter', async () => {
      const eventLog = new MemorySessionEventLog({ maxEvents: 4 });
      for (let index = 0; index < 6; index += 1) {
        await eventLog.append('trunc', [turnEnd()], 'r1');
      }
      const outcome = await readEvents(baseDeps(eventLog), 'trunc', { from: '0', follow: 'false' }, 'safe');
      const events = await collectNdjson(outcome.ndjson!);
      expect(events.some((event) => event.part.type === 'log-truncated')).toBe(true);
    });
  });

  describe('cancelSession', () => {
    it('returns cancelled or no_active_turn from deps', async () => {
      const idle = await cancelSession(baseDeps(new MemorySessionEventLog()), 's');
      expect(idle.body).toEqual({ status: 'no_active_turn' });

      const active = await cancelSession(baseDeps(new MemorySessionEventLog(), {
        cancelTurn: async () => 'cancelled',
      }), 's');
      expect(active.body).toEqual({ status: 'cancelled' });
    });
  });

  describe('readMemory', () => {
    it('returns 403 when memoryOwner denies access', async () => {
      const outcome = await readMemory(
        baseDeps(new MemorySessionEventLog(), {
          memoryOwner: () => null,
        }),
        { tenantId: 't', userId: 'a' },
        'b',
      );
      expect(outcome.status).toBe(403);
    });

    it('returns memory blocks and extracted values for authorized owner', async () => {
      const outcome = await readMemory(
        baseDeps(new MemorySessionEventLog(), {
          memory: {
            readBlocks: async () => [{
              key: 'USER',
              scope: 'user',
              content: 'hello',
              charLimit: 100,
            }],
            readExtracted: async () => [{
              slug: 'facts',
              scope: 'user',
              value: { color: 'blue' },
              updatedAt: '2026-08-01T00:00:00.000Z',
            }],
          },
          memoryOwner: (_p, userId) => userId,
        }),
        { tenantId: 't', userId: 'a' },
        'a',
      );
      expect(outcome.status).toBe(200);
      const body = outcome.body as {
        blocks: Array<{ key: string; content: string }>;
        extracted: Array<{ slug: string }>;
      };
      expect(body.blocks[0]?.key).toBe('USER');
      expect(body.extracted[0]?.slug).toBe('facts');
    });
  });
});

describe('cursor.index is the next unread index (red gate target)', () => {
  it('snapshot cursor equals tail + 1, not the last visible event index', async () => {
    const eventLog = new MemorySessionEventLog();
    await eventLog.append('s', [textDelta('only')], 'r1');
    const outcome = await readSnapshot(baseDeps(eventLog), 's', { limit: '10' }, 'all');
    const body = outcome.body as { cursor: { index: number }; events: LoggedEvent[] };
    expect(body.events[0]!.index).toBe(0);
    expect(body.cursor.index).toBe(1);
  });
});
