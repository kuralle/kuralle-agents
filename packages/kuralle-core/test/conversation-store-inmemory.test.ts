import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';

import { InMemoryConversationStore } from '../src/conversations/index.ts';
import type { Session } from '../src/types/index.ts';

describe('InMemoryConversationStore', () => {
  it('resolveConversationId returns same id within window for same user', async () => {
    const store = new InMemoryConversationStore();

    const first = await store.resolveConversationId({ userId: 'user-1', channelId: 'web' });
    const second = await store.resolveConversationId({ userId: 'user-1', channelId: 'voice' });

    expect(second).toBe(first);
  });

  it('resolveConversationId returns new id after window expires', async () => {
    const store = new InMemoryConversationStore();

    const first = await store.resolveConversationId({ userId: 'user-1', channelId: 'web', windowMs: 1 });
    await Bun.sleep(5);
    const second = await store.resolveConversationId({ userId: 'user-1', channelId: 'voice', windowMs: 1 });

    expect(second).not.toBe(first);
  });

  it('closeConversation forces a fresh id on next resolve', async () => {
    const store = new InMemoryConversationStore();

    const first = await store.resolveConversationId({ userId: 'user-1', channelId: 'web' });
    await store.closeConversation(first);
    const second = await store.resolveConversationId({ userId: 'user-1', channelId: 'sms' });

    expect(second).not.toBe(first);
  });

  it('listSessions returns tracked sessions for a conversation newest first', async () => {
    const store = new InMemoryConversationStore();
    const conversationId = await store.resolveConversationId({ userId: 'user-1', channelId: 'web' });
    const older = makeSession({ id: 'older', conversationId, channelId: 'web', updatedAt: new Date(1000) });
    const newer = makeSession({ id: 'newer', conversationId, channelId: 'voice', updatedAt: new Date(2000) });

    await store.upsertSession(older);
    await store.upsertSession(newer);

    expect((await store.listSessions(conversationId)).map(session => session.id)).toEqual(['newer', 'older']);
  });
});

function makeSession(overrides: Partial<Session>): Session {
  const now = new Date(0);
  return {
    id: overrides.id ?? 'session-1',
    conversationId: overrides.conversationId ?? overrides.id ?? 'session-1',
    channelId: overrides.channelId ?? 'web',
    userId: overrides.userId ?? 'user-1',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    messages: overrides.messages ?? [{ role: 'user', content: 'hello' } as ModelMessage],
    workingMemory: overrides.workingMemory ?? {},
    currentAgent: overrides.currentAgent ?? 'agent-1',
    activeAgentId: overrides.activeAgentId ?? 'agent-1',
    state: overrides.state ?? {},
    metadata: overrides.metadata ?? {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: overrides.agentStates ?? {},
    handoffHistory: overrides.handoffHistory ?? [],
  };
}
