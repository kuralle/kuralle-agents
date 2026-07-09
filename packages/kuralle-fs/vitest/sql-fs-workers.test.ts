// Proves SqlFileSystem runs on REAL Cloudflare workerd over a Durable Object's
// `ctx.storage.sql` (DO SQLite) — the CF-native persistent workspace path, and
// that writes survive across SqlFileSystem instances (the ghost-writes fix).
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SqlBackend } from '../src/sql/types.js';
import { SqlFileSystem } from '../src/sql/sql-fs.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    SQL_FS_DO: DurableObjectNamespace;
  }
}

function doSqlBackend(sql: SqlStorage): SqlBackend {
  return {
    query: (q, ...params) => [...sql.exec(q, ...params)] as never,
    run: (q, ...params) => {
      sql.exec(q, ...params);
    },
  };
}

describe('SqlFileSystem on workerd (DO SQLite)', () => {
  it('round-trips a file over ctx.storage.sql and persists across instances', async () => {
    const id = env.SQL_FS_DO.idFromName('fs-test');
    const stub = env.SQL_FS_DO.get(id);

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const backend = doSqlBackend(state.storage.sql);

      const fs1 = new SqlFileSystem({ backend });
      await fs1.writeFile('/kb/note.md', 'persisted on workerd');
      await fs1.mkdir('/kb/sub', { recursive: true });

      // A fresh SqlFileSystem over the SAME DO storage sees the prior writes.
      const fs2 = new SqlFileSystem({ backend });
      return {
        content: await fs2.readFile('/kb/note.md'),
        dirExists: await fs2.exists('/kb/sub'),
        listing: (await fs2.readdir('/kb')).sort(),
      };
    });

    expect(result.content).toBe('persisted on workerd');
    expect(result.dirExists).toBe(true);
    expect(result.listing).toEqual(['note.md', 'sub']);
  });
});
