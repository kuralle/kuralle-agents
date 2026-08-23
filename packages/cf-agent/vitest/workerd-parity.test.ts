import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { LoggedEvent, StreamPart } from '@kuralle-agents/core';

interface TestMemoryEnv {
  TEST_MEMORY_DO: DurableObjectNamespace;
}

function textDelta(delta: string): StreamPart {
  return { channel: 'client', type: 'text-delta', payload: { id: 't1', delta } };
}

function stripForParity(event: LoggedEvent): Pick<LoggedEvent, 'index' | 'runId' | 'part'> {
  return {
    index: event.index,
    runId: event.runId,
    part: event.part,
  };
}

describe('SqlSessionEventLog workerd parity', () => {
  it('scripted turns yield an identical LoggedEvent sequence under workerd', async () => {
    const bindings = env as unknown as TestMemoryEnv;
    const stub = bindings.TEST_MEMORY_DO.get(bindings.TEST_MEMORY_DO.idFromName('event-log-parity'));
    const script = [
      [textDelta('one')],
      [textDelta('two')],
      [{ channel: 'internal', type: 'turn-end', payload: {} }],
    ];
    const response = await stub.fetch('http://do/event-log-parity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'parity-sess', script, expected: script.length }),
    });
    expect(response.ok).toBe(true);
    const body = await response.json() as {
      node: Array<Pick<LoggedEvent, 'index' | 'runId' | 'part'>>;
      workerd: Array<Pick<LoggedEvent, 'index' | 'runId' | 'part'>>;
    };
    expect(body.workerd).toEqual(body.node);
    expect(body.workerd.length).toBeGreaterThan(0);
    const indices = body.workerd.map((event) => event.index);
    for (let index = 1; index < indices.length; index += 1) {
      expect(indices[index]! - indices[index - 1]!).toBe(1);
    }
  });

  it('persists events in workerd DO sqlite across store instances', async () => {
    const bindings = env as unknown as TestMemoryEnv;
    const stub = bindings.TEST_MEMORY_DO.get(bindings.TEST_MEMORY_DO.idFromName('event-log-durability'));
    const write = await stub.fetch('http://do/event-log-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'durability-sess', parts: [textDelta('persisted')] }),
    });
    expect(write.ok).toBe(true);

    const first = await stub.fetch('http://do/event-log-read?sessionId=durability-sess');
    expect(first.ok).toBe(true);
    const before = await first.json() as { events: LoggedEvent[] };
    expect(before.events.length).toBeGreaterThan(0);

    const second = await stub.fetch('http://do/event-log-read?sessionId=durability-sess');
    expect(second.ok).toBe(true);
    const after = await second.json() as { events: LoggedEvent[] };
    expect(after.events.map(stripForParity)).toEqual(before.events.map(stripForParity));
  });
});
