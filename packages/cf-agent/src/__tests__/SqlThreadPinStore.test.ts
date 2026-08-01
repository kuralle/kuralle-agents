import { describe, expect, it } from 'bun:test';
import type { ThreadPin } from '@kuralle-agents/deployment';
import { SqlThreadPinStore } from '../SqlThreadPinStore.js';
import type { SqlExecutor } from '../types.js';

function memorySql(): SqlExecutor {
  let payload: string | undefined;
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.includes('CREATE TABLE')) return [];
    if (query.includes('SELECT payload')) return payload ? [{ payload }] : [];
    if (query.includes('INSERT INTO kuralle_thread_pin')) {
      payload ??= String(values[1]);
      return [];
    }
    return [];
  }) as SqlExecutor;
}

function assigned(version = 'version-1'): ThreadPin {
  return {
    tenantId: 'tenant-a',
    threadId: 'thread-a',
    agentEntityId: 'support',
    agentVersionId: version,
    artifactDigest: version === 'version-1' ? 'a'.repeat(64) : 'b'.repeat(64),
    runtimeRevisionId: 'runtime-1',
    releaseId: version === 'version-1' ? 'release-1' : 'release-2',
    environment: 'production',
    configGeneration: 1,
    secretGeneration: 1,
    assignedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('SqlThreadPinStore', () => {
  it('resolves once and preserves the original assignment after release changes and eviction', async () => {
    const sql = memorySql();
    const request = {
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
    };
    let resolutions = 0;
    const first = await new SqlThreadPinStore(sql).initialize(request, async () => {
      resolutions += 1;
      return assigned('version-1');
    });
    const afterEviction = await new SqlThreadPinStore(sql).initialize(request, async () => {
      resolutions += 1;
      return assigned('version-2');
    });

    expect(first.agentVersionId).toBe('version-1');
    expect(afterEviction).toEqual(first);
    expect(resolutions).toBe(1);
  });

  it('denies a conflicting tenant before calling the release resolver', async () => {
    const sql = memorySql();
    const store = new SqlThreadPinStore(sql);
    await store.initialize({
      tenantId: 'tenant-a',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
    }, async () => assigned());
    let called = false;

    await expect(new SqlThreadPinStore(sql).initialize({
      tenantId: 'tenant-b',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
    }, async () => {
      called = true;
      return { ...assigned(), tenantId: 'tenant-b' };
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(called).toBe(false);
  });

  it('rejects malformed initialization before control-plane access', async () => {
    let called = false;
    await expect(new SqlThreadPinStore(memorySql()).initialize({
      tenantId: '',
      threadId: 'thread-a',
      agentEntityId: 'support',
      environment: 'production',
    }, async () => {
      called = true;
      return assigned();
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(called).toBe(false);
  });
});
