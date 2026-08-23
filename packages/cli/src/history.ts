import { Command } from 'commander';
import { createClient, reduce, type Block, type TurnView } from '@kuralle-agents/client';
import type { LoggedEvent } from '@kuralle-agents/core';
import type { BuildRuntime } from './agentRuntime.js';
import { UsageError } from './errors.js';
import { fetchHostedSnapshot } from './hostedSession.js';
import { resolveHostedConnection } from './hostedConnection.js';
import { defaultStorePath, sessionStores } from './sessionStores.js';

export interface HistoryOptions {
  session: string;
  store: string;
  from?: number;
  token?: string;
}

function historyCommand(): Command {
  return new Command('history')
    .requiredOption('--session <id>', 'session id')
    .option('--from <index>', 'start at event index', (value) => Number(value))
    .option('--store <file>', 'persist session + event log')
    .option('--server <url>', 'hosted server URL')
    .option('--transport <kind>', 'hosted transport')
    .option('--agent-name <name>', 'hosted agent name')
    .option('--token <token>', 'hosted bearer token')
    .option('--local', 'ignore hosted connection');
}

export function parseHistoryArgs(argv: string[]): HistoryOptions {
  const cmd = historyCommand();
  cmd.parse(argv, { from: 'user' });
  const opts = cmd.opts<HistoryOptions & { local?: boolean }>();
  const from = opts.from;
  if (from !== undefined && (!Number.isInteger(from) || from < 0)) {
    throw new UsageError('--from must be a non-negative integer');
  }
  return {
    session: opts.session,
    store: opts.store ?? defaultStorePath(),
    from,
    token: opts.token,
  };
}

function userTurnText(event: LoggedEvent): string | null {
  if (event.part.type !== 'custom' || event.part.payload.name !== 'user-turn') return null;
  const data = event.part.payload.data;
  if (typeof data === 'object' && data !== null && 'text' in data) {
    return String((data as { text: unknown }).text);
  }
  return String(data ?? '');
}

function splitTurnSegments(events: LoggedEvent[]): LoggedEvent[][] {
  const segments: LoggedEvent[][] = [];
  let current: LoggedEvent[] = [];
  for (const event of events) {
    if (userTurnText(event) !== null) continue;
    current.push(event);
    if (event.part.type === 'done') {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function blocksFromHistoryEvents(events: LoggedEvent[]): Block[] {
  const users: Block[] = [];
  for (const event of events) {
    const text = userTurnText(event);
    if (text !== null) users.push({ id: `user-${event.index}`, kind: 'user', text });
  }
  const segments = splitTurnSegments(events);
  const blocks: Block[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (users[i]) blocks.push(users[i]!);
    blocks.push(...reduce(segments[i]!).blocks);
  }
  for (let i = segments.length; i < users.length; i += 1) {
    blocks.push(users[i]!);
  }
  return blocks;
}

function reduceHistoryView(events: LoggedEvent[], from = 0): TurnView {
  const filtered = events.filter((event) => event.index >= from);
  const view = reduce(filtered);
  view.blocks = blocksFromHistoryEvents(filtered);
  return view;
}

export async function runHistory(argv: string[], buildRuntime: BuildRuntime): Promise<TurnView> {
  const opts = parseHistoryArgs(argv);
  if (!opts.session) throw new UsageError('--session is required');

  const connection = await resolveHostedConnection(argv);
  if (connection) {
    const snap = await fetchHostedSnapshot(connection, opts.session, opts.token);
    return reduceHistoryView(snap.events, opts.from ?? 0);
  }

  const wired = sessionStores(opts.store);
  const demo = await buildRuntime(opts.session, wired.store, wired.traces, wired.eventLog);
  const client = createClient({ kind: 'local', runtime: demo.runtime, eventLog: wired.eventLog });
  const session = client.sessions.attach(opts.session);
  const snap = await session.snapshot();
  return reduceHistoryView(snap.events, opts.from ?? 0);
}
