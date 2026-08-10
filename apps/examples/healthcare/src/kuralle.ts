// This example defaults to Pi. Set KURALLE_DRIVER=ai-sdk to use the built-in AI SDK driver.
import type { SessionStore, TraceStore } from '@kuralle-agents/core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createProductionRuntime } from './production-runtime.js';
import { buildHealthcareAgent } from './agent.js';
import { HealthcareRepository } from './database.js';

const databasePath = resolve(
  process.env.HEALTHCARE_DATABASE_PATH?.trim() ||
    resolve(import.meta.dirname, '../data/healthcare.sqlite'),
);
mkdirSync(dirname(databasePath), { recursive: true });
const repository = new HealthcareRepository(databasePath);

export function buildRuntime(
  _sessionId?: string,
  sessionStore?: SessionStore,
  traceStore?: TraceStore,
) {
  return createProductionRuntime({
    buildAgent: (model) => buildHealthcareAgent(model, repository),
    ...(sessionStore ? { sessionStore } : {}),
    ...(traceStore ? { traceStore } : {}),
  });
}

export default buildRuntime;
