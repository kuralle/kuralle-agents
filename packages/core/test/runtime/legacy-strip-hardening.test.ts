import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { openRun } from '../../src/runtime/openRun.js';
import type { RunState } from '../../src/runtime/durable/types.js';
import type { RunStore } from '../../src/runtime/durable/RunStore.js';
import { StaleWriteError } from '../../src/session/SessionStore.js';
import {
  COMPACTION_SUMMARY_PREFIX,
  loadSanitizedRunState,
  sanitizeRunStateMessages,
  sanitizeSessionMessages,
} from '../../src/runtime/stripSystemRoleMessages.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { makeRunState, makeTestSession, stubModel } from '../core-durable/helpers.js';

const defaultAgentId = 'agent-1';

function agentsMap() {
  const agent = defineAgent({ id: defaultAgentId, model: stubModel });
  return new Map([[agent.id, agent]]);
}

function legacyCompactionMessage(summary = 'User is Jane.'): ModelMessage {
  return {
    role: 'system',
    content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}`,
  };
}

describe('legacy strip hardening', () => {
  it('GET session transcript drops legacy system-role entries on read', async () => {
    const sessionId = 'legacy-session-get';
    const store = new MemoryStore();
    const session = makeTestSession(sessionId);
    session.messages = [
      legacyCompactionMessage(),
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    await store.save(session);

    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel })],
      defaultAgentId,
      sessionStore: store,
    });

    const served = await runtime.getSession(sessionId);
    expect(served).not.toBeNull();
    expect(served!.messages.some((message) => message.role === 'system')).toBe(false);
    expect(served!.messages).toHaveLength(2);

    const stored = await store.get(sessionId);
    expect(stored!.messages.some((message) => message.role === 'system')).toBe(true);
  });

  it('openRun with system-role seedMessages on a fresh session id persists no session', async () => {
    const sessionId = 'orphan-seed-sess';
    const store = new MemoryStore();

    await expect(
      openRun(agentsMap(), {
        sessionId,
        defaultAgentId,
        sessionStore: store,
        seedMessages: [{ role: 'system', content: 'You are helpful.' }],
      }),
    ).rejects.toThrow('seedMessages must not contain role: \'system\' messages');

    expect(await store.get(sessionId)).toBeNull();
  });

  it('concurrent sanitized loads on a legacy run do not write and do not throw', async () => {
    const sessionId = 'concurrent-strip-sess';
    const store = new MemoryStore();
    await store.save(makeTestSession(sessionId));

    let putCalls = 0;
    const inner = new SessionRunStore(store, sessionId);
    const runStore: RunStore = {
      ...inner,
      async putRunState(state: RunState) {
        putCalls += 1;
        throw new StaleWriteError(state.runId, 1, 2);
      },
      getRunState: (runId) => inner.getRunState(runId),
      initRun: (state) => inner.initRun(state),
      appendStep: (runId, record) => inner.appendStep(runId, record),
      finalizeStep: (runId, key, patch) => inner.finalizeStep(runId, key, patch),
      getSteps: (runId) => inner.getSteps(runId),
    };

    const runState = makeRunState(sessionId, sessionId);
    runState.messages = [
      legacyCompactionMessage('Concurrent strip probe.'),
      { role: 'user', content: 'hi' },
    ];
    await inner.putRunState(runState);

    const results = await Promise.all([
      loadSanitizedRunState(runStore, sessionId),
      loadSanitizedRunState(runStore, sessionId),
    ]);

    expect(putCalls).toBe(0);
    for (const loaded of results) {
      expect(loaded).not.toBeNull();
      expect(loaded!.messages.some((message) => message.role === 'system')).toBe(false);
    }
  });
});

describe('sanitizeSessionMessages guard', () => {
  it('strips system-role entries without routing text into the transcript', () => {
    const session = makeTestSession('s');
    session.messages = [
      { role: 'system', content: 'legacy note' },
      { role: 'user', content: 'hi' },
    ];
    expect(sanitizeSessionMessages(session)).toBe(true);
    expect(session.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('loadSanitizedRunState write-on-read guard', () => {
  it('sanitizes legacy run state in memory without persisting', async () => {
    const sessionId = 'no-write-strip';
    const store = new MemoryStore();
    await store.save(makeTestSession(sessionId));
    const inner = new SessionRunStore(store, sessionId);
    let putCalls = 0;
    const runStore: RunStore = {
      ...inner,
      async putRunState(state: RunState) {
        putCalls += 1;
        return inner.putRunState(state);
      },
      getRunState: (runId) => inner.getRunState(runId),
      initRun: (state) => inner.initRun(state),
      appendStep: (runId, record) => inner.appendStep(runId, record),
      finalizeStep: (runId, key, patch) => inner.finalizeStep(runId, key, patch),
      getSteps: (runId) => inner.getSteps(runId),
    };

    const runState = makeRunState(sessionId, sessionId);
    runState.messages = [legacyCompactionMessage('No write probe.'), { role: 'user', content: 'x' }];
    await inner.putRunState(runState);

    const loaded = await loadSanitizedRunState(runStore, sessionId);
    expect(putCalls).toBe(0);
    expect(loaded!.messages.some((message) => message.role === 'system')).toBe(false);

    const raw = await inner.getRunState(sessionId);
    expect(raw!.messages.some((message) => message.role === 'system')).toBe(true);
    expect(sanitizeRunStateMessages(raw!)).toBe(true);
  });
});
