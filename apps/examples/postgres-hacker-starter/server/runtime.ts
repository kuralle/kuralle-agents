// This app defaults to Pi. Set KURALLE_DRIVER=ai-sdk to use the built-in AI SDK driver.
import { PostgresSessionStore, PostgresTraceStore } from '@kuralle-agents/postgres-store';
import { createProductionRuntime } from '@kuralle-examples/shared/runtime';
import { buildHackerAgent } from './agent';
import {
  createEmbeddingFunction,
  createKnowledgeConfig,
  getPool,
  HackerMemoryService,
  HackerRepository,
  migrateDatabase,
} from './database';

let runtimePromise: Promise<ReturnType<typeof createProductionRuntime>> | undefined;
let repositorySingleton: HackerRepository | undefined;

export function getRepository(): HackerRepository {
  repositorySingleton ??= new HackerRepository();
  return repositorySingleton;
}

export function getRuntime() {
  runtimePromise ??= initializeRuntime();
  return runtimePromise;
}

async function initializeRuntime() {
  const pool = getPool();
  await migrateDatabase(pool);
  const repository = getRepository();
  return createProductionRuntime({
    buildAgent: (model) => buildHackerAgent(model, repository),
    sessionStore: new PostgresSessionStore({ client: pool }),
    traceStore: new PostgresTraceStore({ client: pool, retentionMs: 30 * 24 * 60 * 60 * 1000 }),
    knowledge: createKnowledgeConfig(repository, createEmbeddingFunction()),
    memoryService: new HackerMemoryService(repository),
  });
}
