// This example defaults to Pi. Set KURALLE_DRIVER=ai-sdk to use the built-in AI SDK driver.
import type { SessionStore, TraceStore } from '@kuralle-agents/core';
import { nodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { createProductionRuntime } from '@kuralle-examples/shared/runtime';
import { resolve } from 'node:path';
import { buildContentAgent } from './agent.js';

const workspacePath = resolve(
  process.env.CONTENT_WORKSPACE_PATH?.trim() || resolve(import.meta.dirname, '../workspace'),
);
const workspace = nodeFileSystem(workspacePath);

export function buildRuntime(
  _sessionId?: string,
  sessionStore?: SessionStore,
  traceStore?: TraceStore,
) {
  return createProductionRuntime({
    buildAgent: (model) => buildContentAgent(model, workspace),
    ...(sessionStore ? { sessionStore } : {}),
    ...(traceStore ? { traceStore } : {}),
  });
}

export default buildRuntime;
