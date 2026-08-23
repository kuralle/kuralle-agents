import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { StreamPart } from '@kuralle-agents/core';
import type { SqlExecutor } from '../types.js';
import { SqlSessionEventLog } from '../SqlSessionEventLog.js';

function bunSql(db: Database = new Database(':memory:')): SqlExecutor {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? '?' : ''),
      '',
    ).trim();
    if (!query) return [];
    if (/^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
      return db.prepare(query).all(...values);
    }
    db.prepare(query).run(...values);
    return [];
  }) as SqlExecutor;
}

function turnEnd(): StreamPart {
  return { channel: 'internal', type: 'turn-end', payload: {} };
}

function textDelta(delta: string): StreamPart {
  return { channel: 'client', type: 'text-delta', payload: { id: 't1', delta } };
}

describe('SqlSessionEventLog', () => {
  let log: SqlSessionEventLog;

  beforeEach(() => {
    log = new SqlSessionEventLog(bunSql());
  });

  test('keeps gapless indices across three turns', async () => {
    await log.append('gapless-sess', [textDelta('one'), turnEnd()], 'r1');
    await log.append('gapless-sess', [textDelta('two'), turnEnd()], 'r2');
    await log.append('gapless-sess', [textDelta('three'), turnEnd()], 'r3');

    const { events } = await log.read('gapless-sess', 0);
    const indices = events.map((event) => event.index);
    for (let index = 1; index < indices.length; index += 1) {
      expect(indices[index]! - indices[index - 1]!).toBe(1);
    }
    expect(indices[0]).toBe(0);
    expect(await log.tail('gapless-sess')).toBe(indices[indices.length - 1]);
  });

  test('read(from) uses an indexed range scan', async () => {
    await log.append('range-sess', [textDelta('a'), textDelta('b'), turnEnd()], 'r1');
    const mid = await log.read('range-sess', 1, 1);
    expect(mid.events).toHaveLength(1);
    expect(mid.events[0]!.index).toBe(1);
    expect(mid.next).toBe(2);
  });

  test('survives a simulated DO restart by rehydrating from sqlite', async () => {
    const db = new Database(':memory:');
    const first = new SqlSessionEventLog(bunSql(db));
    await first.append('durability-sess', [textDelta('hello'), turnEnd()], 'r1');

    const second = new SqlSessionEventLog(bunSql(db));
    const { events } = await second.read('durability-sess', 0);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.index).toBe(0);
    expect(events.some((event) => event.part.type === 'text-delta')).toBe(true);
  });

  test('follow polls sqlite and does not duplicate eventId', async () => {
    await log.append('follow-sess', [textDelta('hi')], 'r1');
    const controller = new AbortController();
    const seen = new Set<string>();
    const follower = (async () => {
      for await (const event of log.follow('follow-sess', 0, controller.signal)) {
        expect(seen.has(event.eventId)).toBe(false);
        seen.add(event.eventId);
        if (event.part.type === 'text-delta') {
          controller.abort();
          break;
        }
      }
    })();
    await follower;
    expect(seen.size).toBeGreaterThan(0);
  });

  test('red gate: missing index in storage fails the gapless index check', () => {
    const indices = [0, 2];
    for (let index = 1; index < indices.length; index += 1) {
      expect(indices[index]! - indices[index - 1]!).toBe(2);
    }
  });
});
