import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, SkillHandle, ToolContext } from '@kuralle-agents/core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { workspaces } from '../../db/schema.js';
import type { WorkspaceScope } from '../../agent/lib/workspace-scope.js';

/**
 * These need a live Postgres. They skip cleanly without one rather than failing — a missing
 * container is an environment fact, not a defect — but they must be RUN against a real
 * database before this task is called done (see `db:migrate` in the gate list).
 */
export const DB_URL = process.env.DATABASE_URL ?? 'postgres://marketing:marketing@localhost:5433/marketing';

export async function connectDb() {
  const sqlClient = postgres(DB_URL, { max: 5, connect_timeout: 5, onnotice: () => {} });
  try {
    await sqlClient`select 1`;
  } catch {
    await sqlClient.end({ timeout: 5 });
    return undefined;
  }
  return { sqlClient, db: drizzle(sqlClient) };
}

type Session = ToolContext['session'];

let uuidCounter = 0;

/** Builds a minimal but type-honest ToolContext. Only `session` and `getSkill` are ever
 *  exercised by the tools under test; everything else is a typed no-op. */
export function makeCtx(opts: { currentAgent?: string; getSkill?: (name: string) => SkillHandle } = {}): ToolContext {
  const session: Session = {
    id: `sess-${++uuidCounter}`,
    conversationId: `conv-${uuidCounter}`,
    channelId: 'api',
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    workingMemory: {},
    currentAgent: opts.currentAgent ?? 'test-agent',
    agentStates: {},
    handoffHistory: [],
  };
  const runState: RunState = {
    runId: `run-${uuidCounter}`,
    sessionId: session.id,
    status: 'running',
    activeAgentId: session.currentAgent,
    state: {},
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    session,
    runState,
    emit: () => {},
    tool: async () => {
      throw new Error('ctx.tool is not available in this test double');
    },
    now: async () => Date.now(),
    uuid: async () => `uuid-${++uuidCounter}`,
    getSkill:
      opts.getSkill ??
      (() => {
        throw new Error('getSkill is not configured for this test');
      }),
  };
}

/** A resolver whose scope is set by the test, ignoring `ctx` — the real (b5) resolver reads
 *  `ctx`; this double exists purely to drive isolation tests deterministically. */
export function fixedScope(scope: WorkspaceScope) {
  return () => scope;
}

/** Same idea as `fixedScope`, but mutable — lets one tool instance be called "as" different
 *  callers across a test without rebuilding the tools each time. */
export function mutableScope(initial: WorkspaceScope) {
  let current = initial;
  return {
    resolveScope: () => current,
    as(scope: WorkspaceScope) {
      current = scope;
    },
  };
}

export function fakeSkill(files: Record<string, string>): (name: string) => SkillHandle {
  return (name: string) => ({
    name,
    file(path: string) {
      return {
        async text() {
          const content = files[path];
          if (content === undefined) {
            throw new Error(`ENOENT: [skills] Resource "${path}" not found for skill "${name}".`);
          }
          return content;
        },
        async bytes() {
          return new TextEncoder().encode(await this.text());
        },
      };
    },
  });
}

type Db = NonNullable<Awaited<ReturnType<typeof connectDb>>>['db'];

export async function createWorkspace(db: Db, name: string) {
  const [row] = await db.insert(workspaces).values({ name }).returning();
  if (!row) throw new Error('createWorkspace: insert returned no row');
  return row;
}

export async function withStorageRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'marketing-team-assets-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function suffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
