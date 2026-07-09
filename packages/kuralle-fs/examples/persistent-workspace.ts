#!/usr/bin/env bun
/**
 * Persistence smoke: a SqlFileSystem-backed workspace survives a "restart".
 * Writes a file + a SKILL.md through one workspace, then opens a SECOND
 * SqlFileSystem over the SAME SQLite database (simulating a fresh process) and
 * reads them back. This is the ghost-writes fix: fs state is durable, so the
 * durable journal and the filesystem agree across restarts.
 *
 * Platform choice (OTB) — pass the SQL handle your platform gives you:
 *   Bun:        sqlFileSystem(bunSqliteBackend(new Database(path)))   // shown below
 *   Node:       nodeSqlFileSystem('/path/agent.db')                    // from '@kuralle-agents/fs/node'
 *   Cloudflare: sqlFileSystem(ctx.storage.sql)  or  sqlFileSystem(env.DB)  // DO SQLite / D1
 *
 * Run:  bun run packages/kuralle-fs/examples/persistent-workspace.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { sqlFileSystem, fsSkillStore, type SqlBackend } from '@kuralle-agents/fs';

// One tiny adapter turns any SQLite handle into the two-method SqlBackend.
function bunSqliteBackend(db: Database): SqlBackend {
  return {
    query: (sql, ...p) => db.query(sql).all(...p) as never,
    run: (sql, ...p) => {
      db.query(sql).run(...p);
    },
  };
}

const SKILL = `---
name: refunds
description: Handle refund requests within the 30-day policy window.
---

# Refunds
Verify the order date is within 30 days, then issue the refund.
`;

async function main() {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'kuralle-fs-')), 'agent.db');
  console.log(`workspace db: ${dbPath}\n`);

  // ── Process 1: write a file + a skill, then "exit" (close the handle). ──
  {
    const db = new Database(dbPath);
    const fs = sqlFileSystem(bunSqliteBackend(db));
    await fs.mkdir('/kb', { recursive: true });
    await fs.writeFile('/kb/hours.md', 'Open 9-5, Mon-Fri.');
    await fs.mkdir('/skills/refunds', { recursive: true });
    await fs.writeFile('/skills/refunds/SKILL.md', SKILL);
    db.close();
    console.log('process 1 wrote /kb/hours.md and /skills/refunds/SKILL.md, then closed the db');
  }

  // ── Process 2: a fresh SqlFileSystem over the SAME db file (restart). ──
  const fs2 = sqlFileSystem(bunSqliteBackend(new Database(dbPath)));
  const hours = await fs2.readFile('/kb/hours.md');
  const skills = await fsSkillStore(fs2).list();

  console.log('process 2 read /kb/hours.md:', JSON.stringify(hours));
  console.log('process 2 fsSkillStore.list():', JSON.stringify(skills));

  const failures: string[] = [];
  if (hours !== 'Open 9-5, Mon-Fri.') failures.push('file did not survive the restart');
  if (!skills.some((s) => s.name === 'refunds')) failures.push('skill did not survive the restart');

  if (failures.length) {
    console.error('PERSISTENCE FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
  console.log('\nPERSISTENCE PASSED — file + skill written by process 1 were read by process 2 over the same SQLite store.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
