import { Pool } from 'pg';
import { PostgresSessionStore, PostgresTraceStore } from '@kuralle-agents/postgres-store';
import { supportBackendFromEnv } from '../src/backend';
import { createSupportRuntime } from '../src/runtime';

let runtimePromise: Promise<ReturnType<typeof createSupportRuntime>> | undefined;
let pool: Pool | undefined;

export function getSupportRuntime() {
  runtimePromise ??= Promise.resolve(initializeRuntime());
  return runtimePromise;
}

function initializeRuntime() {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const apiKey = requiredEnv('OPENAI_API_KEY');
  pool ??= new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 8_000,
  });
  const backend = supportBackendFromEnv({
    SUPPORT_DEMO_MODE: process.env.SUPPORT_DEMO_MODE,
    SUPPORT_API_URL: process.env.SUPPORT_API_URL,
    SUPPORT_API_TOKEN: process.env.SUPPORT_API_TOKEN,
    production: process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production',
  });
  return createSupportRuntime({
    apiKey,
    modelId: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini',
    backend,
    sessionStore: new PostgresSessionStore({ client: pool }),
    traceStore: new PostgresTraceStore({
      client: pool,
      retentionMs: 30 * 24 * 60 * 60 * 1_000,
    }),
  });
}

export function requiredEnv(name: 'DATABASE_URL' | 'OPENAI_API_KEY' | 'SUPPORT_IDENTITY_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  if (name === 'SUPPORT_IDENTITY_SECRET' && value.length < 32) {
    throw new Error('SUPPORT_IDENTITY_SECRET must contain at least 32 characters.');
  }
  return value;
}
