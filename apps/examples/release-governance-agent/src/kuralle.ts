// This production example defaults to Pi. Set KURALLE_DRIVER=ai-sdk for the built-in driver.
import type { SessionStore, TraceStore } from '@kuralle-agents/core';
import { createProductionRuntime } from '@kuralle-examples/shared/runtime';
import { resolve } from 'node:path';
import { buildReleaseGovernanceAgent } from './agent.js';
import { loadReleaseAgentConfig } from './config.js';

export async function buildRuntime(
  _sessionId?: string,
  sessionStore?: SessionStore,
  traceStore?: TraceStore,
) {
  const config = await loadReleaseAgentConfig();
  const skillRoot = resolve(import.meta.dirname, '../workspace');
  return createProductionRuntime({
    buildAgent: (model) => buildReleaseGovernanceAgent({
      model,
      config,
      skillRoot,
      githubToken: process.env.GITHUB_TOKEN,
    }),
    ...(sessionStore ? { sessionStore } : {}),
    ...(traceStore ? { traceStore } : {}),
  });
}

export default buildRuntime;
