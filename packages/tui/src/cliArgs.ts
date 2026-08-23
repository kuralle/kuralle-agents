import {
  connectionToTarget,
  inferTargetKind,
  resolveHostedConnection,
  type Auth,
  type Target,
} from '@kuralle-agents/client';
import { parseFlagArgs } from './parseFlagArgs.js';
import { loadLocalTarget } from './agentLoader.js';

export interface CliLaunchOptions {
  server?: string;
  local?: string;
  transport?: string;
  agentName?: string;
  sessionId?: string;
  userId?: string;
  tokenEnv?: string;
  model?: string;
  envFile?: string;
}

function authFromEnv(tokenEnv?: string): Auth | undefined {
  const key = tokenEnv?.trim() || 'KURALLE_TOKEN';
  const token = process.env[key]?.trim() || process.env.KURALLE_TOKEN?.trim();
  return token ? { token } : undefined;
}

export async function resolveLaunchTarget(options: CliLaunchOptions): Promise<{
  target: Target;
  connection?: Awaited<ReturnType<typeof resolveHostedConnection>>;
  label: string;
} | undefined> {
  if (options.local) {
    const local = await loadLocalTarget(options.local, options.model);
    return { target: local.target, label: `local · ${local.label}` };
  }

  // Before resolveHostedConnection, not after: it normalises through `new URL(...)`, which throws
  // on a filesystem path, so `kuralle-tui ./agent.ts` died with "cannot be parsed as a URL" and
  // never reached the local branch below. The scheme decides the transport, so the scheme is
  // inspected first.
  if (options.server && inferTargetKind(options.server) === 'local') {
    const local = await loadLocalTarget(options.server, options.model);
    return { target: local.target, label: `local · ${local.label}` };
  }

  const connection = await resolveHostedConnection({
    server: options.server,
    transport: options.transport,
    agentName: options.agentName,
  });
  if (!connection) return undefined;
  const target = connectionToTarget(connection, authFromEnv(options.tokenEnv));
  const label = connection.agentName ? `${connection.server} · ${connection.agentName}` : connection.server;
  return { target, connection, label };
}

export function parseCliArgv(argv: string[]): CliLaunchOptions {
  const { positional, flags } = parseFlagArgs(argv.join(' '));
  const local = flags.get('local');
  const server = positional[0] ?? flags.get('server');
  return {
    server: local ? undefined : server,
    local: local && local !== 'true' ? local : undefined,
    transport: flags.get('transport'),
    agentName: flags.get('agent-name'),
    sessionId: flags.get('session'),
    userId: flags.get('user'),
    tokenEnv: flags.get('token-env'),
    model: flags.get('model'),
    envFile: flags.get('env-file'),
  };
}
