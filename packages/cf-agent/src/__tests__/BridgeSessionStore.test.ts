import { describe, expect, it } from 'bun:test';
import type { ConversationAuditEntry } from '@kuralle-agents/core';
import { BridgeSessionStore } from '../BridgeSessionStore.js';
import type { SqlExecutor } from '../types.js';

function memorySql(): SqlExecutor {
  const rows = new Map<string, string>();
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('CREATE TABLE')) return [];
    if (query.includes('SELECT state')) {
      const state = rows.get(String(values[0]));
      return state ? [{ state }] : [];
    }
    if (query.includes('INSERT INTO kuralle_orchestration')) {
      rows.set(String(values[0]), String(values[1]));
      return [];
    }
    if (query.includes('DELETE FROM kuralle_orchestration')) {
      rows.delete(String(values[0]));
      return [];
    }
    return [];
  }) as SqlExecutor;
}

describe('BridgeSessionStore metadata', () => {
  it('round-trips durable audit metadata through orchestration storage', async () => {
    const audit: ConversationAuditEntry = {
      type: 'agent-start',
      at: '2026-08-01T00:00:00.000Z',
      sessionId: 'thread-1',
      agentId: 'support',
    };
    const store = new BridgeSessionStore({
      sqlExecutor: memorySql(),
      cfMessages: [],
      sessionId: 'thread-1',
      defaultAgentId: 'support',
    });
    const session = await store.get('thread-1');
    expect(session).not.toBeNull();
    session!.metadata = {
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      lastActiveAt: new Date('2026-08-01T00:00:01.000Z'),
      totalTokens: 12,
      totalSteps: 1,
      handoffHistory: [],
      audit: [audit],
    };

    await store.save(session!);
    const restored = await store.get('thread-1');

    expect(restored?.metadata?.audit).toEqual([audit]);
    expect(restored?.metadata?.createdAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(restored?.metadata?.lastActiveAt).toEqual(new Date('2026-08-01T00:00:01.000Z'));
  });
});
