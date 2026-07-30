import 'dotenv/config';
import { Pool } from 'pg';
import { createRuntime } from '@kuralle-agents/core';
import { PostgresSessionStore, PostgresTraceStore } from '@kuralle-agents/postgres-store';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { buildCommerceAgent } from '../src/agent.js';
import type { CommerceEnv } from '../src/env.js';
import { requireEnv } from '../src/env.js';
import { createGatewayRuntime } from '../src/gateway.js';
import { createPorulleClient } from '../src/porulle.js';
import { createProductMatcher, createProductRetrieval } from '../src/search.js';
import { PostgresOrderLedger } from './order-ledger.js';

let runtimePromise: ReturnType<typeof initialize> | undefined;

function fromProcess(): CommerceEnv & { DATABASE_URL: string } {
  const env = process.env as unknown as CommerceEnv & { DATABASE_URL: string };
  requireEnv(env);
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return env;
}

async function initialize() {
  const env = fromProcess();
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 8 });
  const matcher = createProductMatcher(env, env.DATABASE_URL);
  const gateway = createGatewayRuntime(env);
  const agent = buildCommerceAgent({
    model: gateway.controlModel,
    env,
    retrieval: createProductRetrieval(matcher),
    porulle: createPorulleClient({ baseUrl: env.PORULLE_URL, apiKey: env.PORULLE_STOREFRONT_KEY }),
    ledger: new PostgresOrderLedger(pool),
  });
  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: gateway.controlModel,
    sessionStore: new PostgresSessionStore({ client: pool }),
    tracing: {
      enabled: true,
      sampling: 1,
      store: new PostgresTraceStore({ client: pool, retentionMs: 30 * 24 * 60 * 60 * 1_000 }),
    },
    driver: new PiDriver({
      model: gateway.piModel,
      models: gateway.models,
      streamFn: gateway.streamFn,
      getApiKey: gateway.getApiKey,
      maxSteps: 24,
    }),
  });
}

export function getRuntime() {
  runtimePromise ??= initialize();
  return runtimePromise;
}
