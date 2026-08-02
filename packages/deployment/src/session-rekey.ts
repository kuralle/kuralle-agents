import type { SessionStore } from '@kuralle-agents/core';
import { scopedKey } from './store.js';

export interface SessionRekeyResult {
  /** Sessions moved from a raw thread id to its tenant-scoped key. */
  moved: number;
  /** Sessions already scoped, so nothing to do. */
  alreadyScoped: number;
  /** Raw session ids whose tenant could not be resolved; left untouched. */
  unresolved: string[];
  /** Raw session ids whose scoped key was already occupied; left untouched. */
  conflicts: string[];
}

export interface SessionRekeyOptions {
  sessions: SessionStore;
  /**
   * Maps a raw thread id to the tenant that owned it, or null when unknown.
   *
   * Under the pre-scoping schema the pin table keyed on `thread_id` alone, so
   * this mapping is a function — one row per thread id, and its `tenant_id`
   * column is the answer. Wire it to a single query over your own pin table;
   * that keeps this helper free of any one database's dialect.
   */
  resolveTenantId(threadId: string): Promise<string | null> | string | null;
  /** Report what would change without writing anything. Defaults to false. */
  dryRun?: boolean;
}

/**
 * Moves conversation history from the pre-tenant-scoping session key to the
 * scoped one, so an upgrade does not silently start every thread over.
 *
 * Scoping the deployment session key is what makes two tenants sharing a thread
 * id safe, but it also renames every existing session: history written under
 * `94778984729` is invisible to a runtime now reading
 * `11:tenant-a|11:94778984729`. Nothing errors — the lookup simply misses and a
 * blank conversation begins, which is why this has to be run deliberately
 * rather than discovered.
 *
 * Idempotent, and safe to run against a partially migrated store: a raw thread
 * id can never contain `|`, so an id that does is already scoped and is skipped.
 * An occupied destination is reported rather than overwritten — losing the
 * newer conversation to "fix" the older one is not an improvement.
 */
export async function rekeySessionsByTenant(
  options: SessionRekeyOptions,
): Promise<SessionRekeyResult> {
  const result: SessionRekeyResult = {
    moved: 0,
    alreadyScoped: 0,
    unresolved: [],
    conflicts: [],
  };

  for (const session of await options.sessions.list()) {
    if (session.id.includes('|')) {
      result.alreadyScoped += 1;
      continue;
    }
    const tenantId = await options.resolveTenantId(session.id);
    if (!tenantId) {
      result.unresolved.push(session.id);
      continue;
    }
    const target = scopedKey(tenantId, session.id);
    if (await options.sessions.get(target)) {
      result.conflicts.push(session.id);
      continue;
    }
    if (!options.dryRun) {
      // `version` is compare-and-swap state belonging to the OLD key, and the
      // destination has no history to swap against. Carrying it over makes the
      // very first write fail its CAS check; the scoped key starts at 0.
      await options.sessions.save({ ...session, id: target, version: 0 });
      await options.sessions.delete(session.id);
    }
    result.moved += 1;
  }

  return result;
}
