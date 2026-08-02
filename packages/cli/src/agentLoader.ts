import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRuntime,
  MemoryStore,
  MemoryTraceStore,
  type AgentConfig,
  type Runtime,
  type SessionStore,
  type TraceStore,
} from '@kuralle-agents/core';
import type { AgentRuntime, BuildRuntime } from './agentRuntime.js';
import { buildDemoRuntime } from './demoAgent.js';
import { fileSessionStore } from './fileStore.js';
import { fileTraceStore } from './fileTraceStore.js';
import { readAgentRunState } from './runState.js';
import { resolveCliModel } from './resolveModel.js';
import { newSessionId } from './sessionId.js';

export interface LoaderOptions {
  modelFlag?: string;
}

type ResolvedExport =
  | { kind: 'runtime'; value: Runtime }
  | { kind: 'agent'; value: AgentConfig }
  | { kind: 'factory'; value: BuildRuntimeFactory };

type BuildRuntimeFactory = (
  sessionId?: string,
  store?: SessionStore,
  traceStore?: TraceStore,
) => AgentRuntime | Runtime | Promise<AgentRuntime | Runtime>;

const NAMED_KEYS = ['runtime', 'agent', 'buildRuntime', 'build'] as const;

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

function isAgentRuntime(value: unknown): value is AgentRuntime {
  return (
    typeof value === 'object'
    && value !== null
    && 'runtime' in value
    && 'readState' in value
    && isRuntime((value as AgentRuntime).runtime)
  );
}

function classifyExport(value: unknown): ResolvedExport | undefined {
  if (isRuntime(value)) return { kind: 'runtime', value };
  if (isAgentConfig(value)) return { kind: 'agent', value };
  if (typeof value === 'function') return { kind: 'factory', value: value as BuildRuntimeFactory };
  return undefined;
}

function resolveModuleExport(mod: Record<string, unknown>): ResolvedExport | undefined {
  const candidates: unknown[] = [];
  if ('default' in mod) candidates.push(mod.default);
  for (const key of NAMED_KEYS) {
    if (key in mod) candidates.push(mod[key]);
  }
  for (const candidate of candidates) {
    const resolved = classifyExport(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function defaultStores(
  sessionId: string | undefined,
  store?: SessionStore,
  traceStore?: TraceStore,
): { sessionStore: SessionStore; traceStore: TraceStore; fileBacked: boolean } {
  if (store) {
    return {
      sessionStore: store,
      traceStore: traceStore ?? new MemoryTraceStore(),
      fileBacked: false,
    };
  }
  // sim: buildRuntime() with no args → file-backed session store
  if (sessionId === undefined) {
    const path = join(process.cwd(), 'runs/tui-sessions.json');
    return {
      sessionStore: fileSessionStore(path),
      traceStore: traceStore ?? fileTraceStore(path.replace(/\.json$/, '') + '.traces.json'),
      fileBacked: true,
    };
  }
  // chat one-shot: sessionId only → in-memory
  return {
    sessionStore: new MemoryStore(),
    traceStore: traceStore ?? new MemoryTraceStore(),
    fileBacked: false,
  };
}

function assembleAgentRuntime(
  runtime: Runtime,
  sessionStore: SessionStore,
  sessionId: string,
  agentId: string,
): AgentRuntime {
  return {
    runtime,
    store: sessionStore,
    sessionId,
    agentId,
    label: `agent: ${agentId}`,
    readState: () => readAgentRunState(sessionStore, sessionId),
  };
}

function buildFromAgent(
  agent: AgentConfig,
  options: LoaderOptions | undefined,
): BuildRuntime {
  return (sessionId?, store?, traceStore?) => {
    const sid = sessionId ?? newSessionId();
    const stores = defaultStores(sessionId, store, traceStore);
    const model = resolveCliModel(agent, options?.modelFlag);
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore: stores.sessionStore,
      defaultModel: model,
      tracing: { store: stores.traceStore },
    });
    return assembleAgentRuntime(runtime, stores.sessionStore, sid, agent.id);
  };
}

function buildFromRuntime(runtime: Runtime): BuildRuntime {
  return (sessionId?) => {
    const sid = sessionId ?? newSessionId();
    const sessionStore = runtime.getSessionStore();
    const agentId = 'agent';
    return assembleAgentRuntime(runtime, sessionStore, sid, agentId);
  };
}

function buildFromFactory(factory: BuildRuntimeFactory): BuildRuntime {
  return async (sessionId?, store?, traceStore?) => {
    const sid = sessionId ?? newSessionId();
    const stores = defaultStores(sessionId, store, traceStore);
    const result = await factory(sid, stores.sessionStore, stores.traceStore);
    if (isAgentRuntime(result)) return result;
    if (isRuntime(result)) {
      return assembleAgentRuntime(result, stores.sessionStore, sid, 'agent');
    }
    console.error('buildRuntime factory must return Runtime or AgentRuntime');
    process.exit(2);
  };
}

export async function resolveBuildRuntime(
  agentPath?: string,
  options?: LoaderOptions,
): Promise<BuildRuntime> {
  if (!agentPath) return buildFromFactory(buildDemoRuntime);

  const abs = resolve(agentPath);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const resolved = resolveModuleExport(mod);
  if (!resolved) {
    console.error(
      `Agent module must export a Runtime, AgentConfig (defineAgent), or buildRuntime factory: ${abs}`,
    );
    process.exit(2);
  }

  switch (resolved.kind) {
    case 'agent':
      return buildFromAgent(resolved.value, options);
    case 'runtime':
      return buildFromRuntime(resolved.value);
    case 'factory':
      return buildFromFactory(resolved.value);
  }
}