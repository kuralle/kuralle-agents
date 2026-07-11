import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildRuntime } from './agentRuntime.js';
import { buildDemoRuntime } from './demoAgent.js';

export async function resolveBuildRuntime(agentPath?: string): Promise<BuildRuntime> {
  if (!agentPath) return buildDemoRuntime;

  const abs = resolve(agentPath);
  const mod = (await import(pathToFileURL(abs).href)) as { buildRuntime?: BuildRuntime };
  if (typeof mod.buildRuntime !== 'function') {
    console.error(`Agent module must export buildRuntime(sessionId?, store?): ${abs}`);
    process.exit(2);
  }
  return mod.buildRuntime;
}