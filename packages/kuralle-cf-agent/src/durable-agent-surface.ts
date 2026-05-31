import type { HarnessConfig } from '@kuralle-agents/core';
import type { Connection, WSMessage } from 'agents';
import type { UIMessage } from 'ai';
import type { SqlExecutor } from './types.js';

export interface DurableObjectAgentSurface<Env = unknown, State = unknown> {
  readonly sql: SqlExecutor;
  readonly ctx: { id: { toString(): string } };
  readonly env: Env;
  readonly state: State;
  readonly messages: UIMessage[];
  keepAlive?: () => Promise<() => void>;
  setState?: (state: State) => void;
  onConnect?: (connection: Connection, ...rest: unknown[]) => void | Promise<void>;
  onClose?: (connection: Connection, ...rest: unknown[]) => void | Promise<void>;
  onMessage?: (connection: Connection, message: WSMessage) => void | Promise<void>;
  getAgents?: () => HarnessConfig['agents'];
  getDefaultAgentId?: () => string;
  getRuntimeConfig?: () => Partial<HarnessConfig>;
}

export function durableAgentSurface<Env = unknown, State = unknown>(
  agent: unknown,
): DurableObjectAgentSurface<Env, State> {
  return agent as DurableObjectAgentSurface<Env, State>;
}
