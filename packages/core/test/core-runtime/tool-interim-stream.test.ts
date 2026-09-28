import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { defineTool } from '../../src/tools/effect/index.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { StreamPart, TurnHandle } from '../../src/types/stream.js';
import { stubModel } from '../core-durable/helpers.js';

async function collect(handle: TurnHandle): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of handle.events) parts.push(part);
  await handle;
  return parts;
}

function delayedTool(name: string, interim?: string) {
  return defineTool({
    name,
    description: name,
    input: z.object({}),
    interim,
    interimAfterMs: 0,
    execute: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { ok: true };
    },
  });
}

const driver: ChannelDriver = {
  async runAgentTurn(_node, ctx) {
    await ctx.tool('lookup', {});
    const id = 'answer';
    ctx.emit({ channel: 'client', type: 'text-start', payload: { id } });
    ctx.emit({ channel: 'client', type: 'text-delta', payload: { id, delta: 'The answer.' } });
    ctx.emit({ channel: 'client', type: 'text-end', payload: { id } });
    return { text: 'The answer.', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: '' };
  },
};

describe('Runtime tool interim stream metadata', () => {
  it('marks initial tool filler and leaves ordinary answer text unmarked', async () => {
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'first', instructions: 'Answer.', model: stubModel })],
      defaultAgentId: 'first',
      tools: { lookup: delayedTool('lookup', 'Checking...') },
    });
    const parts = await collect(runtime.run({ sessionId: 'interim-first', input: 'Hi', driver }));
    const start = parts.find(p => p.type === 'text-start' && p.payload.kind === 'interim');
    expect(start).toMatchObject({ channel: 'client', payload: { kind: 'interim', toolName: 'lookup' } });
    const id = start?.type === 'text-start' ? start.payload.id : '';
    expect(parts).toContainEqual({ channel: 'client', type: 'text-delta', payload: { id, delta: 'Checking...' } });
    expect(parts).toContainEqual({ channel: 'client', type: 'text-end', payload: { id } });
    expect(parts.filter(p => p.type === 'text-start' && p.payload.kind === 'interim')).toHaveLength(1);
    expect(parts).toContainEqual({ channel: 'client', type: 'text-start', payload: { id: 'answer' } });
  });

  it('marks filler from the target tool after a handoff', async () => {
    let turns = 0;
    const handoffDriver: ChannelDriver = {
      async runAgentTurn(_node, ctx) {
        turns++;
        if (turns === 1) return { text: '', toolResults: [], control: { type: 'handoff' as const, target: 'second' } };
        await ctx.tool('lookup', {});
        return { text: 'Done.', toolResults: [] };
      },
      async awaitUser() { return { type: 'message', input: '' }; },
    };
    const runtime = createRuntime({
      agents: [
        defineAgent({ id: 'first', instructions: 'Route.', model: stubModel, routes: [{ agent: 'second', when: 'help' }] }),
        defineAgent({ id: 'second', instructions: 'Answer.', model: stubModel }),
      ],
      defaultAgentId: 'first',
      tools: { lookup: delayedTool('lookup', 'On it...') },
    });
    const parts = await collect(runtime.run({ sessionId: 'interim-handoff', input: 'Hi', driver: handoffDriver }));
    expect(turns).toBe(2);
    expect(parts.some(p => p.type === 'handoff' && p.payload.targetAgent === 'second')).toBe(true);
    expect(parts.some(p => p.type === 'text-start' && p.payload.kind === 'interim' && p.payload.toolName === 'lookup')).toBe(true);
  });

  it('does not mark ordinary text when no tool interim is configured', async () => {
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'first', instructions: 'Answer.', model: stubModel })],
      defaultAgentId: 'first',
      tools: { lookup: delayedTool('lookup') },
    });
    const parts = await collect(runtime.run({ sessionId: 'interim-none', input: 'Hi', driver }));
    expect(parts.some(p => p.type === 'text-start' && p.payload.kind === 'interim')).toBe(false);
    expect(parts).toContainEqual({ channel: 'client', type: 'text-start', payload: { id: 'answer' } });
  });
});
