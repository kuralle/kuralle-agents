import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRuntime,
  MemorySessionEventLog,
  MemoryStore,
  MemoryTraceStore,
  type AgentConfig,
  type Runtime,
  type SessionEventLog,
} from '@kuralle-agents/core';
import type { Target } from '@kuralle-agents/client';

type BuildRuntimeFactory = (
  sessionId?: string,
  store?: MemoryStore,
  traceStore?: MemoryTraceStore,
  eventLog?: SessionEventLog,
) => Runtime | Promise<Runtime>;

export interface LocalTargetBundle {
  target: Target;
  label: string;
}

function isRuntime(value: unknown): value is Runtime {
  return typeof value === 'object' && value !== null && typeof (value as Runtime).run === 'function';
}

function isAgentConfig(value: unknown): value is AgentConfig {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as AgentConfig).id === 'string'
    && 'instructions' in value
    && !isRuntime(value)
  );
}

function isAgentRuntime(value: unknown): value is { runtime: Runtime } {
  return (
    typeof value === 'object'
    && value !== null
    && 'runtime' in value
    && isRuntime((value as { runtime: Runtime }).runtime)
  );
}

function resolveExport(mod: Record<string, unknown>): {
  kind: 'runtime' | 'agent' | 'factory';
  value: Runtime | AgentConfig | BuildRuntimeFactory;
} | undefined {
  if ('default' in mod) {
    if (isRuntime(mod.default)) return { kind: 'runtime', value: mod.default };
    if (isAgentConfig(mod.default)) return { kind: 'agent', value: mod.default };
    if (typeof mod.default === 'function') return { kind: 'factory', value: mod.default as BuildRuntimeFactory };
  }
  for (const key of ['runtime', 'agent', 'buildRuntime', 'build'] as const) {
    if (!(key in mod)) continue;
    const value = mod[key];
    if (isRuntime(value)) return { kind: 'runtime', value };
    if (isAgentConfig(value)) return { kind: 'agent', value };
    if (typeof value === 'function') return { kind: 'factory', value: value as BuildRuntimeFactory };
  }
  return undefined;
}

function localTarget(runtime: Runtime, eventLog: SessionEventLog, label: string): LocalTargetBundle {
  return {
    target: { kind: 'local', runtime, eventLog },
    label,
  };
}

async function runtimeFromModule(abs: string, modelFlag?: string): Promise<LocalTargetBundle> {
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const resolved = resolveExport(mod);
  if (!resolved) {
    throw new Error(`Agent module must export Runtime, AgentConfig, or buildRuntime factory: ${abs}`);
  }

  const eventLog = new MemorySessionEventLog();
  const store = new MemoryStore();
  const traceStore = new MemoryTraceStore();

  switch (resolved.kind) {
    case 'runtime': {
      const runtime = resolved.value as Runtime;
      const wiredLog = runtime.getEventLog?.() ?? eventLog;
      return localTarget(runtime, wiredLog, abs);
    }
    case 'agent': {
      const agent = resolved.value as AgentConfig;
      if (!agent.model && !modelFlag) {
        throw new Error('Agent has no model; pass --model.');
      }
      const runtime = createRuntime({
        agents: [agent],
        defaultAgentId: agent.id,
        sessionStore: store,
        defaultModel: agent.model ?? (modelFlag as never),
        tracing: { store: traceStore },
        eventLog,
      });
      return localTarget(runtime, eventLog, agent.id);
    }
    case 'factory': {
      const factory = resolved.value as BuildRuntimeFactory;
      const result = await factory(undefined, store, traceStore, eventLog);
      if (isAgentRuntime(result)) {
        const wiredLog = result.runtime.getEventLog?.() ?? eventLog;
        return localTarget(result.runtime, wiredLog, abs);
      }
      if (!isRuntime(result)) {
        throw new Error('buildRuntime factory must return Runtime');
      }
      const wiredLog = result.getEventLog?.() ?? eventLog;
      return localTarget(result, wiredLog, abs);
    }
  }
}

export async function loadLocalTarget(agentPath: string, modelFlag?: string): Promise<LocalTargetBundle> {
  const abs = resolve(agentPath);
  return runtimeFromModule(abs, modelFlag);
}
