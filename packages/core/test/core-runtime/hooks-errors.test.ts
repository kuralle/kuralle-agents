import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { markSessionOutcome } from '../../src/runtime/outcomeMarking.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { Hooks } from '../../src/types/hooks.js';
import { stubModel } from '../core-durable/helpers.js';
import { makeTestSession } from '../core-durable/helpers.js';

afterEach(() => {
  mock.restore();
});

type LifecycleHook = 'onStart' | 'onStreamPart' | 'onEnd' | 'onConversationEnd';

const successfulDriver: ChannelDriver = {
  async runAgentTurn() {
    return { text: 'ok', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: 'next' };
  },
};

function runtimeWithHooks(hooks: Hooks, sessionStore: MemoryStore) {
  return createRuntime({
    agents: [defineAgent({ id: 'agent', instructions: 'help', model: stubModel })],
    defaultAgentId: 'agent',
    defaultModel: stubModel,
    sessionStore,
    hooks,
  });
}

function hookFailure(name: string, mode: 'throw' | 'reject'): () => void | Promise<void> {
  if (mode === 'throw') {
    return () => {
      throw new Error(`${name}-${mode}`);
    };
  }
  return async () => {
    throw new Error(`${name}-${mode}`);
  };
}

function hooksWithFailure(name: LifecycleHook, mode: 'throw' | 'reject'): Hooks {
  const failure = hookFailure(name, mode);
  switch (name) {
    case 'onStart':
      return { onStart: failure };
    case 'onStreamPart':
      return { onStreamPart: failure };
    case 'onEnd':
      return { onEnd: failure };
    case 'onConversationEnd':
      return { onConversationEnd: failure };
  }
}

async function allowHookReportsToSettle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('lifecycle hook error isolation', () => {
  for (const mode of ['throw', 'reject'] as const) {
    for (const name of ['onStart', 'onStreamPart', 'onEnd', 'onConversationEnd'] as const) {
      it(`${name} ${mode} does not fail a successful run`, async () => {
        const reports: string[] = [];
        spyOn(console, 'error').mockImplementation((...args) => reports.push(args.map(String).join(' ')));
        const sessionId = `${name}-${mode}`;
        const sessionStore = new MemoryStore();
        if (name === 'onConversationEnd') {
          await sessionStore.save(makeTestSession(sessionId));
          const session = await sessionStore.get(sessionId);
          if (!session) throw new Error(`Missing test session ${sessionId}`);
          await markSessionOutcome(sessionStore, session, 'resolved');
        }
        const result = await runtimeWithHooks(hooksWithFailure(name, mode), sessionStore).run({
          sessionId,
          input: 'hello',
          driver: successfulDriver,
        });

        await allowHookReportsToSettle();
        expect(result.text).toBe('ok');
        expect(reports.some((report) => report.includes(`Hook ${name} failed`))).toBe(true);
      });
    }
  }

  it('keeps onStreamPart fire-and-forget when the callback remains pending', async () => {
    let started = false;
    let release!: () => void;
    const hooks: Hooks = {
      onStreamPart: () => {
        if (started) return;
        started = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };

    const result = await runtimeWithHooks(hooks, new MemoryStore()).run({
      sessionId: 'onStreamPart-pending',
      input: 'hello',
      driver: successfulDriver,
    });

    expect(result.text).toBe('ok');
    expect(started).toBe(true);
    release();
  });

  it('reports the hook error details', async () => {
    const reports: string[] = [];
    spyOn(console, 'error').mockImplementation((...args) => reports.push(args.map(String).join(' ')));
    const result = await runtimeWithHooks({ onStart: hookFailure('onStart', 'throw') }, new MemoryStore()).run({
      sessionId: 'hook-error-details',
      input: 'hello',
      driver: successfulDriver,
    });

    expect(result.text).toBe('ok');
    expect(reports.some((report) => report.includes('Hook onStart failed') && report.includes('onStart-throw'))).toBe(true);
  });

  it('continues closeRun persistence after onConversationEnd fails', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const sessionId = 'onConversationEnd-persistence';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const session = await sessionStore.get(sessionId);
    if (!session) throw new Error(`Missing test session ${sessionId}`);
    await markSessionOutcome(sessionStore, session, 'resolved');

    await runtimeWithHooks({ onConversationEnd: hookFailure('onConversationEnd', 'throw') }, sessionStore).run({
      sessionId,
      input: 'hello',
      driver: successfulDriver,
    });

    const stored = await sessionStore.get(sessionId);
    expect(stored?.messages.some((message) => message.role === 'user' && message.content === 'hello')).toBe(true);
  });

  for (const mode of ['throw', 'reject'] as const) {
    it(`onError ${mode} preserves the original run error`, async () => {
      const reports: string[] = [];
      spyOn(console, 'error').mockImplementation((...args) => reports.push(args.map(String).join(' ')));
      const original = new Error(`original-${mode}`);
      const sessionStore = new MemoryStore();
      const driver: ChannelDriver = {
        async runAgentTurn() {
          throw original;
        },
        async awaitUser() {
          return { type: 'message', input: 'next' };
        },
      };

      await expect(
        runtimeWithHooks({ onError: hookFailure('onError', mode) }, sessionStore).run({
          sessionId: `onError-${mode}`,
          input: 'hello',
          driver,
        }),
      ).rejects.toBe(original);

      await allowHookReportsToSettle();
      expect(reports.some((report) => report.includes('Hook onError failed'))).toBe(true);
    });
  }
});
