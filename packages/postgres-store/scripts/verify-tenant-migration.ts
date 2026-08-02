/**
 * Verifies the pin and lease migrations against a REAL PostgreSQL server.
 *
 * The unit suite runs on pg-mem, which cannot express this scenario at all: it
 * throws on `CREATE TABLE IF NOT EXISTS` when the table already exists, and
 * "the table already exists with the old key" is precisely what a migration has
 * to survive. So this check exists outside the suite rather than pretending a
 * mock covers it.
 *
 *   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=pw --name kuralle-pg postgres:16
 *   POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55432/postgres \
 *     bun packages/postgres-store/scripts/verify-tenant-migration.ts
 *
 * Exits non-zero on any failed assertion.
 */

import { Pool } from 'pg';
import { PostgresDeploymentStore } from '../src/PostgresDeploymentStore.js';
import { PostgresThreadExecutionCoordinator } from '../src/PostgresThreadExecutionCoordinator.js';

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error('POSTGRES_URL is required — see the header of this file.');
  process.exit(2);
}

const AT = '2026-08-01T00:00:00.000Z';
const DIGEST = '0'.repeat(64);
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  failures.push(label);
}

// A Pool, not a Client: the store calls connect() to run its migration in a
// transaction, and a bare Client cannot be reused that way.
const client = new Pool({ connectionString: url });

// A clean slate that looks like a pre-tenant-scoping deployment.
await client.query('DROP TABLE IF EXISTS kuralle_deploy_thread_pins CASCADE');
await client.query('DROP TABLE IF EXISTS kuralle_thread_leases CASCADE');

console.log('\n== pin table: old key -> composite ==');
await client.query(`CREATE TABLE kuralle_deploy_thread_pins (
  thread_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_entity_id TEXT NOT NULL,
  agent_version_id TEXT NOT NULL, artifact_digest CHAR(64) NOT NULL,
  runtime_revision_id TEXT NOT NULL, release_id TEXT NOT NULL, branch TEXT,
  environment TEXT NOT NULL, config_generation INTEGER NOT NULL,
  secret_generation INTEGER NOT NULL, assigned_at TIMESTAMPTZ NOT NULL)`);
await client.query(
  `INSERT INTO kuralle_deploy_thread_pins VALUES
   ('shared-thread','tenant-a','support','legacy-version',$1,
    'runtime-1','legacy-release',NULL,'production',1,1,$2)`,
  [DIGEST, AT],
);

// Migrating twice proves idempotence, not just success.
const store = new PostgresDeploymentStore({ client, autoMigrate: false });
await store.migrate();
await store.migrate();

const pinKey = await client.query(
  `SELECT a.attname FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'kuralle_deploy_thread_pins'::regclass AND i.indisprimary
    ORDER BY a.attname`,
);
check(
  'primary key is (tenant_id, thread_id)',
  pinKey.rows.map(r => r.attname).join(',') === 'tenant_id,thread_id',
  pinKey.rows.map(r => r.attname),
);

const survived = await client.query(
  `SELECT agent_version_id FROM kuralle_deploy_thread_pins
    WHERE tenant_id='tenant-a' AND thread_id='shared-thread'`,
);
check('pre-existing row survived', survived.rows[0]?.agent_version_id === 'legacy-version',
  survived.rows[0]);

// The whole point: a second tenant may now hold the same thread id.
await client.query(
  `INSERT INTO kuralle_deploy_thread_pins VALUES
   ('shared-thread','tenant-b','support','version-b',$1,
    'runtime-1','release-b',NULL,'production',1,1,$2)`,
  [DIGEST, AT],
);
const both = await client.query(
  `SELECT count(*)::int AS n FROM kuralle_deploy_thread_pins WHERE thread_id='shared-thread'`,
);
check('two tenants hold the same thread id', both.rows[0]?.n === 2, both.rows[0]);

// And the ON CONFLICT the running code actually issues resolves against it.
await client.query(
  `INSERT INTO kuralle_deploy_thread_pins VALUES
   ('shared-thread','tenant-b','support','version-b',$1,
    'runtime-1','release-b',NULL,'production',1,1,$2)
   ON CONFLICT(tenant_id,thread_id) DO NOTHING`,
  [DIGEST, AT],
);
check('ON CONFLICT(tenant_id,thread_id) resolves', true);

console.log('\n== lease table: old key -> composite ==');
await client.query(`CREATE TABLE kuralle_thread_leases (
  thread_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`);
await client.query(
  `INSERT INTO kuralle_thread_leases VALUES ('shared-thread','tenant-a','node-a', now() + interval '1 hour')`,
);

const coordinator = new PostgresThreadExecutionCoordinator({ client });
// The first acquire triggers migrate(); tenant-a's lease is live and must not
// block tenant-b on the same id.
const leaseB = await coordinator.acquire({
  tenantId: 'tenant-b', threadId: 'shared-thread', ownerId: 'node-b', ttlMs: 5_000,
});
check('tenant-b acquires while tenant-a holds the same thread id', leaseB !== null);

const blocked = await coordinator.acquire({
  tenantId: 'tenant-b', threadId: 'shared-thread', ownerId: 'node-b2', ttlMs: 5_000,
});
check('mutual exclusion still holds within one tenant', blocked === null);

const stillA = await client.query(
  `SELECT owner_id FROM kuralle_thread_leases WHERE tenant_id='tenant-a' AND thread_id='shared-thread'`,
);
check("tenant-a's lease untouched", stillA.rows[0]?.owner_id === 'node-a', stillA.rows[0]);

await client.end();

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
