// This example defaults to Pi. Set KURALLE_DRIVER=ai-sdk to use the built-in AI SDK driver.
import type { SessionStore, TraceStore } from '@kuralle-agents/core';
import { createProductionRuntime } from '@kuralle-examples/shared/runtime';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildHotelReceptionist } from './agent.js';
import { HotelRepository } from './database.js';

const databasePath = resolve(
  process.env.HOTEL_DATABASE_PATH?.trim() || resolve(import.meta.dirname, '../data/hotel.sqlite'),
);
mkdirSync(dirname(databasePath), { recursive: true });
const repository = new HotelRepository(databasePath);

export function buildRuntime(
  _sessionId?: string,
  sessionStore?: SessionStore,
  traceStore?: TraceStore,
) {
  return createProductionRuntime({
    buildAgent: (model) => buildHotelReceptionist(model, repository),
    ...(sessionStore ? { sessionStore } : {}),
    ...(traceStore ? { traceStore } : {}),
  });
}

export default buildRuntime;
