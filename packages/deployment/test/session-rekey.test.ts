/**
 * Scoping the deployment session key renames every existing session. Nothing
 * throws when that happens — the lookup misses and a blank conversation starts,
 * which is why the failure has to be caught here rather than in production.
 */

import { describe, expect, it } from 'bun:test';
import { MemoryStore } from '@kuralle-agents/core';
import type { Session } from '@kuralle-agents/core';
import { rekeySessionsByTenant, scopedKey } from '../src/index.ts';

const AT = '2026-08-02T00:00:00.000Z';

function session(id: string, text: string): Session {
  return {
    id,
    messages: [{ role: 'user', content: text }],
    createdAt: AT,
    updatedAt: AT,
  } as unknown as Session;
}

async function storeWith(...sessions: Session[]): Promise<MemoryStore> {
  const store = new MemoryStore();
  for (const item of sessions) await store.save(item);
  return store;
}

// Under the old schema the pin table keyed on thread_id alone, so this mapping
// is a function.
const OWNERS: Record<string, string> = {
  '94778984729': 'tenant-a',
  'thread-b': 'tenant-b',
};
const resolveTenantId = (threadId: string) => OWNERS[threadId] ?? null;

describe('rekeying sessions onto the tenant-scoped key', () => {
  it('moves history to the key the runtime now reads', async () => {
    const sessions = await storeWith(session('94778984729', 'the code word is ZANZIBAR'));

    const result = await rekeySessionsByTenant({ sessions, resolveTenantId });

    expect(result.moved).toBe(1);
    const moved = await sessions.get(scopedKey('tenant-a', '94778984729'));
    expect(moved?.messages[0]).toMatchObject({ content: 'the code word is ZANZIBAR' });
    // The old key must be gone, or the next rekey moves it a second time and a
    // stale copy outlives the conversation it belongs to.
    expect(await sessions.get('94778984729')).toBeNull();
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    const sessions = await storeWith(session('94778984729', 'first'));

    await rekeySessionsByTenant({ sessions, resolveTenantId });
    const second = await rekeySessionsByTenant({ sessions, resolveTenantId });

    expect(second.moved).toBe(0);
    expect(second.alreadyScoped).toBe(1);
    expect((await sessions.get(scopedKey('tenant-a', '94778984729')))?.messages[0])
      .toMatchObject({ content: 'first' });
  });

  it('leaves a session alone when its tenant cannot be resolved', async () => {
    const sessions = await storeWith(session('orphan-thread', 'nobody claims me'));

    const result = await rekeySessionsByTenant({ sessions, resolveTenantId });

    expect(result.moved).toBe(0);
    expect(result.unresolved).toEqual(['orphan-thread']);
    // Untouched beats guessed: a wrong tenant would hand one customer's history
    // to another, which is the very thing this work exists to prevent.
    expect(await sessions.get('orphan-thread')).not.toBeNull();
  });

  it('refuses to overwrite a conversation already at the destination', async () => {
    const sessions = await storeWith(
      session('94778984729', 'old raw history'),
      session(scopedKey('tenant-a', '94778984729'), 'newer scoped history'),
    );

    const result = await rekeySessionsByTenant({ sessions, resolveTenantId });

    expect(result.moved).toBe(0);
    expect(result.conflicts).toEqual(['94778984729']);
    expect((await sessions.get(scopedKey('tenant-a', '94778984729')))?.messages[0])
      .toMatchObject({ content: 'newer scoped history' });
    expect(await sessions.get('94778984729')).not.toBeNull();
  });

  it('writes nothing on a dry run while still reporting the plan', async () => {
    const sessions = await storeWith(session('94778984729', 'untouched'));

    const result = await rekeySessionsByTenant({ sessions, resolveTenantId, dryRun: true });

    expect(result.moved).toBe(1);
    expect(await sessions.get('94778984729')).not.toBeNull();
    expect(await sessions.get(scopedKey('tenant-a', '94778984729'))).toBeNull();
  });
});
