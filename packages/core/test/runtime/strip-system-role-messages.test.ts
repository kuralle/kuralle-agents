import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { AiSdkModelTurnLoop } from '../../src/runtime/channels/AiSdkModelTurnLoop.js';
import type { ModelTurnLoopInput, ModelTurnLoopState } from '../../src/runtime/channels/ModelTurnLoop.js';
import { COMPACTION_SUMMARY_PREFIX } from '../../src/runtime/stripSystemRoleMessages.js';
import {
  loadSanitizedRunState,
  rejectSystemRoleInCallerMessages,
  sanitizeRunStateMessages,
} from '../../src/runtime/stripSystemRoleMessages.js';
import { openRun } from '../../src/runtime/openRun.js';
import { addSystemNote, readSystemNote } from '../../src/runtime/systemNotes.js';
import { systemNoteBlocks } from '../../src/runtime/systemNotes.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { makeRunState, makeTestSession, stubModel } from '../core-durable/helpers.js';

const defaultAgentId = 'agent-1';

function agentsMap() {
  const agent = defineAgent({ id: defaultAgentId, model: stubModel });
  return new Map([[agent.id, agent]]);
}

function legacyCompactionMessage(summary = 'User is Jane; ordered cake #42.'): ModelMessage {
  return {
    role: 'system',
    content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}`,
  };
}

describe('strip system-role messages from persisted run state', () => {
  it('legacy compaction summary is stripped into system notes on load', async () => {
    const sessionId = 'legacy-compact-sess';
    const store = new MemoryStore();
    await store.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(store, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.messages = [
      legacyCompactionMessage(),
      { role: 'user', content: 'follow up question' },
    ];
    await runStore.putRunState(runState);

    const loaded = await loadSanitizedRunState(runStore, sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.some((message) => message.role === 'system')).toBe(false);
    expect(systemNoteBlocks(loaded!).join('\n')).toContain('User is Jane');
    expect(systemNoteBlocks(loaded!).join('\n')).toContain('Conversation summary');
  });

  it('openRun loads legacy state through the normal path', async () => {
    const sessionId = 'legacy-open-sess';
    const store = new MemoryStore();
    await store.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(store, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.messages = [
      legacyCompactionMessage('Billing dispute on invoice 99.'),
      { role: 'user', content: 'any update?' },
    ];
    await runStore.putRunState(runState);

    const opened = await openRun(agentsMap(), {
      sessionId,
      defaultAgentId,
      sessionStore: store,
      runStore,
      input: 'hello',
    });

    expect(opened.runState.messages.some((message) => message.role === 'system')).toBe(false);
    expect(systemNoteBlocks(opened.runState).join('\n')).toContain('invoice 99');
  });

  it('rejects system-role seedMessages with a clear error', async () => {
    const sessionId = 'seed-reject-sess';
    const store = new MemoryStore();
    await store.save(makeTestSession(sessionId));

    await expect(
      openRun(agentsMap(), {
        sessionId,
        defaultAgentId,
        sessionStore: store,
        seedMessages: [{ role: 'system', content: 'You are helpful.' }],
      }),
    ).rejects.toThrow('seedMessages must not contain role: \'system\' messages');

    expect(() =>
      rejectSystemRoleInCallerMessages(
        [{ role: 'system', content: 'nope' }],
        'seedMessages',
      ),
    ).toThrow('seedMessages must not contain role: \'system\' messages');
  });

  it('rejects system-role historyDelta with a clear error', async () => {
    const sessionId = 'delta-reject-sess';
    const store = new MemoryStore();
    await store.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(store, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.messages = [{ role: 'user', content: 'hi' }];
    await runStore.putRunState(runState);

    await expect(
      openRun(agentsMap(), {
        sessionId,
        defaultAgentId,
        sessionStore: store,
        runStore,
        historyDelta: [{ role: 'system', content: 'injected' }],
      }),
    ).rejects.toThrow('historyDelta must not contain role: \'system\' messages');
  });

  it('loading an already-clean state twice does not mutate it', async () => {
    const sessionId = 'idempotent-sess';
    const store = new MemoryStore();
    await store.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(store, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.messages = [{ role: 'user', content: 'clean transcript' }];
    await runStore.putRunState(runState);

    const first = await loadSanitizedRunState(runStore, sessionId);
    const firstUpdatedAt = first!.updatedAt;
    const firstNotes = systemNoteBlocks(first!);

    const second = await loadSanitizedRunState(runStore, sessionId);
    expect(second!.updatedAt).toBe(firstUpdatedAt);
    expect(systemNoteBlocks(second!)).toEqual(firstNotes);
    expect(second!.messages).toEqual([{ role: 'user', content: 'clean transcript' }]);
    expect(sanitizeRunStateMessages(second!)).toBe(false);
  });

  it('AiSdkModelTurnLoop guard fires before streamText', async () => {
    const { session, runStore, runState } = await setupHarness('guard-sess', 'guard-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const input = {
      purpose: 'speaking',
      node: { id: 'answer', localTools: {} },
      ctx,
      model: stubModel,
      messages: [{ role: 'system', content: 'legacy leak' }, { role: 'user', content: 'hi' }],
      system: [],
      volatileSystemBlocks: [],
      tools: {},
      maxSteps: 1,
    } as unknown as ModelTurnLoopInput;
    const state: ModelTurnLoopState = { toolResults: [], toolCallsMade: [], toolMessages: [] };

    await expect(
      new AiSdkModelTurnLoop().run(input, state, () => {}),
    ).rejects.toThrow("Model message at index 0 has role 'system'");
  });
});

async function setupHarness(sessionId: string, runId: string) {
  const session = makeTestSession(sessionId);
  const memoryStore = new MemoryStore();
  await memoryStore.save(session);
  const runStore = new SessionRunStore(memoryStore, sessionId);
  const runState = makeRunState(sessionId, runId);
  await runStore.initRun(runState);
  return { session, memoryStore, runStore, runState };
}

describe('legacy system messages that match no known prefix', () => {
  it('preserves every one of them, not just the last', () => {
    // Regression: a shared tag made addSystemNote replace the previous note, so the
    // first unknown message was silently discarded by the second.
    const runState = {
      runId: 'r-multi',
      sessionId: 's-multi',
      state: {},
      updatedAt: 0,
      messages: [
        { role: 'system', content: 'ALPHA-UNKNOWN-ONE' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'BETA-UNKNOWN-TWO' },
      ],
    } as unknown as RunState;

    expect(sanitizeRunStateMessages(runState)).toBe(true);
    expect(runState.messages.some((message) => message.role === 'system')).toBe(false);

    const blocks = systemNoteBlocks(runState).join('\n');
    expect(blocks).toContain('ALPHA-UNKNOWN-ONE');
    expect(blocks).toContain('BETA-UNKNOWN-TWO');
  });
});

describe('legacy notes that can occur more than once', () => {
  it('keeps every escalation-resume note, not just the last', () => {
    const runState = {
      runId: 'r-esc',
      sessionId: 's-esc',
      state: {},
      updatedAt: 0,
      messages: [
        { role: 'system', content: '[A human agent handled this] FIRST-ESCALATION' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: '[A human agent handled this] SECOND-ESCALATION' },
      ],
    } as unknown as RunState;

    sanitizeRunStateMessages(runState);
    const blocks = systemNoteBlocks(runState).join('\n');
    expect(blocks).toContain('FIRST-ESCALATION');
    expect(blocks).toContain('SECOND-ESCALATION');
  });

  it('does not let a stale legacy message overwrite a fresher note', () => {
    const runState = {
      runId: 'r-fresh',
      sessionId: 's-fresh',
      state: {},
      updatedAt: 0,
      messages: [
        { role: 'system', content: `${COMPACTION_SUMMARY_PREFIX}\nSTALE-LEGACY-TEXT` },
        { role: 'user', content: 'hi' },
      ],
    } as unknown as RunState;
    addSystemNote(runState, `${COMPACTION_SUMMARY_PREFIX}\nFRESH-NOTE-TEXT`, {
      lifetime: 'run',
      tag: 'compaction-summary',
    });

    sanitizeRunStateMessages(runState);
    const blocks = systemNoteBlocks(runState).join('\n');
    expect(blocks).toContain('FRESH-NOTE-TEXT');
    expect(blocks).toContain('STALE-LEGACY-TEXT');
    expect(readSystemNote(runState, 'compaction-summary')).toContain('FRESH-NOTE-TEXT');
  });
});
