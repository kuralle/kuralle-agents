import { Command } from 'commander';
import { createClient } from '@kuralle-agents/client';
import type { SessionEventLog } from '@kuralle-agents/core';
import type { BuildRuntime } from './agentRuntime.js';
import { UsageError } from './errors.js';
import { postHostedCancel } from './hostedSession.js';
import { resolveHostedConnection } from './hostedConnection.js';
import { defaultStorePath, sessionStores } from './sessionStores.js';

export interface CancelOptions {
  session: string;
  store: string;
}

export interface CancelResult {
  status: 'cancelled' | 'no_active_turn';
}

function cancelCommand(): Command {
  return new Command('cancel')
    .requiredOption('--session <id>', 'session id')
    .option('--store <file>', 'persist session + event log')
    .option('--server <url>', 'hosted server URL')
    .option('--transport <kind>', 'hosted transport')
    .option('--agent-name <name>', 'hosted agent name')
    .option('--token <token>', 'hosted bearer token')
    .option('--local', 'ignore hosted connection');
}

export function parseCancelArgs(argv: string[]): CancelOptions & { token?: string } {
  const cmd = cancelCommand();
  cmd.parse(argv, { from: 'user' });
  const opts = cmd.opts<CancelOptions & { token?: string }>();
  return {
    session: opts.session,
    store: opts.store ?? defaultStorePath(),
    token: opts.token,
  };
}

async function turnLooksActive(eventLog: SessionEventLog, sessionId: string): Promise<boolean> {
  const tail = await eventLog.tail(sessionId);
  if (tail < 0) return false;
  const { events } = await eventLog.read(sessionId, tail, 1);
  const last = events[0]?.part.type;
  return last !== undefined && !isTerminalPart(last);
}

function isTerminalPart(type: string): boolean {
  return type === 'done' || type === 'paused' || type === 'error';
}

export async function runCancel(argv: string[], buildRuntime: BuildRuntime): Promise<CancelResult> {
  const opts = parseCancelArgs(argv);
  if (!opts.session) throw new UsageError('--session is required');

  const connection = await resolveHostedConnection(argv);
  if (connection) {
    return postHostedCancel(connection, opts.session, opts.token);
  }

  const wired = sessionStores(opts.store);
  const demo = await buildRuntime(opts.session, wired.store, wired.traces, wired.eventLog);
  const client = createClient({ kind: 'local', runtime: demo.runtime, eventLog: wired.eventLog });
  const session = client.sessions.attach(opts.session);
  const active = await turnLooksActive(wired.eventLog, opts.session);
  await session.cancel('cli cancel');
  return { status: active ? 'cancelled' : 'no_active_turn' };
}
