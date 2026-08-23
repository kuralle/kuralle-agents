import {
  connectionToTarget,
  inferTargetKind,
  type Auth,
  type HostedConnection,
  type Target,
} from '@kuralle-agents/client';
import { parseFlagArgs } from './parseFlagArgs.js';
import { loadLocalTarget, type LocalTargetBundle } from './agentLoader.js';

export interface ConnectCommandInput {
  args: string;
  tokenEnv?: string;
}

export interface AgentCommandInput {
  path: string;
  model?: string;
}

function authFromEnv(tokenEnv?: string): Auth | undefined {
  const key = tokenEnv?.trim() || 'KURALLE_TOKEN';
  const token = process.env[key]?.trim() || process.env.KURALLE_TOKEN?.trim();
  return token ? { token } : undefined;
}

function hostedConnectionFromUrl(
  url: string,
  flags: Map<string, string>,
): HostedConnection {
  const transport = flags.get('transport');
  const agentName = flags.get('agent-name');
  const kind = inferTargetKind(url);
  if (kind === 'cloudflare' && !agentName) {
    throw new Error('Cloudflare transport requires --agent-name.');
  }
  return {
    server: url,
    ...(transport ? { transport: transport as HostedConnection['transport'] } : {}),
    ...(agentName ? { agentName } : {}),
  };
}

export function targetLabel(target: Target): string {
  switch (target.kind) {
    case 'http':
      return target.url;
    case 'cloudflare':
      return `${target.url} · ${target.agentName}`;
    case 'local':
      return 'local · agent';
    default: {
      const _exhaustive: never = target;
      return String(_exhaustive);
    }
  }
}

export async function resolveConnectTarget(input: ConnectCommandInput): Promise<{
  target: Target;
  connection?: HostedConnection;
  label: string;
}> {
  const { positional, flags } = parseFlagArgs(input.args);
  const url = positional[0];
  if (!url) throw new Error('Usage: /connect <url> [--agent-name x] [--transport http|cloudflare] [--token-env VAR]');

  const auth = authFromEnv(input.tokenEnv ?? flags.get('token-env'));

  if (inferTargetKind(url) === 'local') {
    const local: LocalTargetBundle = await loadLocalTarget(url);
    return { target: local.target, label: `local · ${local.label}` };
  }

  const connection = hostedConnectionFromUrl(url, flags);
  const target = connectionToTarget(connection, auth);
  return { target, connection, label: targetLabel(target) };
}

export async function resolveAgentTarget(input: AgentCommandInput): Promise<{
  target: Target;
  label: string;
  agentPath: string;
}> {
  const local = await loadLocalTarget(input.path, input.model);
  return { target: local.target, label: `local · ${local.label}`, agentPath: input.path };
}

export function parseConnectSlash(argsTail: string): ConnectCommandInput {
  const { flags } = parseFlagArgs(argsTail);
  return { args: argsTail, tokenEnv: flags.get('token-env') };
}

export function parseAgentSlash(argsTail: string): AgentCommandInput {
  const { positional, flags } = parseFlagArgs(argsTail);
  const path = positional[0];
  if (!path) throw new Error('Usage: /agent <path.ts> [--model id]');
  return { path, model: flags.get('model') };
}
