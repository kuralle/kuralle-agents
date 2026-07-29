import { describe, expect, it } from 'bun:test';
import { createRuntime } from '../../src/runtime/Runtime.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { TurnHandle } from '../../src/types/stream.js';
import { stubModel } from '../core-durable/helpers.js';

function mockDriver(
  runAgentTurn: ChannelDriver['runAgentTurn'],
): ChannelDriver {
  return {
    runAgentTurn,
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

async function collectEvents(handle: TurnHandle) {
  const parts = [];
  for await (const part of handle.events) parts.push(part);
  return parts;
}

describe('HarnessConfig.driver', () => {
  it('uses one runtime-level driver for normal, flow, wake, and adapter entry points', async () => {
    let calls = 0;
    const driver: ChannelDriver = mockDriver(async () => {
      calls += 1;
      return { text: 'pi answer', toolResults: [] };
    });
    const runtime = createRuntime({
      agents: [{ id: 'agent', name: 'Agent', model: stubModel, instructions: 'Answer' }],
      defaultAgentId: 'agent',
      driver,
    });

    const first = runtime.run({ sessionId: 'default-driver', input: 'hello' });
    const parts = await collectEvents(first);
    const result = await first;

    expect(calls).toBe(1);
    expect(result.text).toBe('pi answer');
    expect(parts.some((part) => part.type === 'done')).toBe(true);
  });

  it('keeps RunOptions.driver as the per-run override', async () => {
    const runtimeDriver = mockDriver(async () => ({ text: 'runtime', toolResults: [] }));
    const overrideDriver = mockDriver(async () => ({ text: 'override', toolResults: [] }));
    const runtime = createRuntime({
      agents: [{ id: 'agent', name: 'Agent', model: stubModel, instructions: 'Answer' }],
      defaultAgentId: 'agent',
      driver: runtimeDriver,
    });

    const handle = runtime.run({ sessionId: 'override-driver', input: 'hello', driver: overrideDriver });
    await collectEvents(handle);
    expect((await handle).text).toBe('override');
  });
});
