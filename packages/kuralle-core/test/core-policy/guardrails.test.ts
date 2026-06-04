import { describe, expect, it, mock, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor, defineTool } from '../../src/tools/effect/index.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { createToolEnforcer } from '../../src/guards/ToolEnforcer.js';
import type { EnforcementRule } from '../../src/types/tool.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { OutputProcessor } from '../../src/types/processors.js';
import type { ChannelDriver } from '../../src/types/channel.js';

afterEach(() => {
  mock.restore();
});

describe('guardrails', () => {
  it('redacts assistant text before emit and before message persistence', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'Email me at user@example.com please.' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('redact-sess', 'redact-run');
    const emitted: string[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      outputProcessors: [{
        id: 'email-redact',
        process: ({ text }) => ({
          action: 'modify',
          text: text.replace(/user@example\.com/g, '[REDACTED]'),
        }),
      }],
      emit: (part) => {
        if (part.type === 'text-delta') {
          emitted.push(part.delta);
        }
      },
    });

    const node = reply({ id: 'r', instructions: 'Reply' });
    const driver = new TextDriver();
    const turn = await driver.runAgentTurn(resolveReplyNode(node, runState.state), ctx);

    expect(turn.text).toBe('Email me at [REDACTED] please.');
    expect(emitted).toEqual(['Email me at [REDACTED] please.']);
    expect(turn.text).not.toContain('user@example.com');
  });

  it('output processor modifies text before emit', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'secret-token-12345' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });

    const scrubber: OutputProcessor = {
      id: 'scrub',
      process: ({ text }) => ({
        action: 'modify',
        text: text.replace(/secret-token-\d+/g, '[SCRUBBED]'),
      }),
    };

    const { session, runStore, runState } = await setupDurableHarness('out-proc', 'out-proc-run');
    const emitted: string[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      outputProcessors: [scrubber],
      emit: (part) => {
        if (part.type === 'text-delta') {
          emitted.push(part.delta);
        }
      },
    });

    const driver = new TextDriver();
    const turn = await driver.runAgentTurn(
      resolveReplyNode(reply({ id: 'r', instructions: 'x' }), runState.state),
      ctx,
    );

    expect(turn.text).toBe('[SCRUBBED]');
    expect(emitted).toEqual(['[SCRUBBED]']);
  });

  it('ToolEnforcer blocks a disallowed tool call', async () => {
    const denyDangerous: EnforcementRule = {
      name: 'deny-dangerous',
      description: 'Block dangerous tool',
      appliesTo: ['dangerous'],
      check: () => ({ allowed: false, reason: 'Tool dangerous is not allowed' }),
    };

    const executor = new CoreToolExecutor({
      tools: {
        dangerous: defineTool({
          name: 'dangerous',
          description: 'Dangerous side effect',
          execute: async () => ({ ok: true }),
        }),
      },
      enforcer: createToolEnforcer([denyDangerous]),
    });

    const { session, runStore, runState } = await setupDurableHarness('enforce-sess', 'enforce-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: executor,
      model: stubModel,
      emit: () => {},
    });

    await expect(ctx.tool('dangerous', {})).rejects.toThrow('Tool dangerous is not allowed');
  });

  it('maxTurns cap ends the host loop', async () => {
    const agent = defineAgent({
      id: 'limited',
      instructions: 'Reply briefly',
      limits: { maxTurns: 1 },
    });

    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'hello', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'more' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('maxturns', 'maxturns-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      limits: { maxTurns: 1 },
      emit: () => {},
    });

    const first = await hostLoop({ agent, run: runState, driver, ctx });
    expect(first.kind).toBe('turnComplete');

    const second = await hostLoop({ agent, run: runState, driver, ctx });
    expect(second).toEqual({ kind: 'ended', reason: 'maxTurns exceeded (1)' });
  });
});
