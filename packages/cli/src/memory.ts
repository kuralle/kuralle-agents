import { Command } from 'commander';
import type { LoggedEvent, SessionEventLog } from '@kuralle-agents/core';
import type { BuildRuntime } from './agentRuntime.js';
import { readLocalMemory, resolveAgentMemoryContext } from './agentMemory.js';
import { UsageError } from './errors.js';
import { fetchHostedMemory, followHostedMemoryEvents } from './hostedSession.js';
import { resolveHostedConnection } from './hostedConnection.js';
import { defaultStorePath, sessionStores } from './sessionStores.js';

const MEMORY_EVENT_TYPES = new Set(['extraction', 'context-compacted']);

export interface MemoryOptions {
  user: string;
  session?: string;
  watch?: boolean;
  store: string;
  agentPath?: string;
  token?: string;
}

export interface MemoryWatchOptions {
  signal?: AbortSignal;
  idleAfterDoneMs?: number;
  onEvent?: (event: LoggedEvent) => void;
}

function memoryCommand(): Command {
  return new Command('memory')
    .requiredOption('--user <id>', 'user id for scoped memory')
    .option('--session <id>', 'session id (required with --watch)')
    .option('--watch', 'follow the session log for extraction and compaction events')
    .option('--store <file>', 'persist session + event log')
    .option('--server <url>', 'hosted server URL')
    .option('--transport <kind>', 'hosted transport')
    .option('--agent-name <name>', 'hosted agent name')
    .option('--token <token>', 'hosted bearer token')
    .option('--agent <path>', 'agent module path')
    .option('--local', 'ignore hosted connection');
}

export function parseMemoryArgs(argv: string[]): MemoryOptions {
  const cmd = memoryCommand();
  cmd.parse(argv, { from: 'user' });
  const opts = cmd.opts<Omit<MemoryOptions, 'agentPath'> & { local?: boolean; agent?: string }>();
  return {
    user: opts.user,
    session: opts.session,
    watch: opts.watch === true,
    store: opts.store ?? defaultStorePath(),
    agentPath: opts.agent,
    token: opts.token,
  };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function writeNdjson(event: LoggedEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function isMemoryEvent(event: LoggedEvent): boolean {
  return MEMORY_EVENT_TYPES.has(event.part.type);
}

export async function watchMemoryEvents(
  eventLog: SessionEventLog,
  sessionId: string,
  options: MemoryWatchOptions = {},
): Promise<LoggedEvent[]> {
  const from = (await eventLog.tail(sessionId)) + 1;
  const seen: LoggedEvent[] = [];
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let sawDone = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idleLimit = options.idleAfterDoneMs ?? 2_000;

  const armIdleExit = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!sawDone) return;
    idleTimer = setTimeout(() => controller.abort(), idleLimit);
  };

  for await (const event of eventLog.follow(sessionId, from, controller.signal)) {
    if (event.part.type === 'done') sawDone = true;
    if (isMemoryEvent(event)) {
      (options.onEvent ?? writeNdjson)(event);
      seen.push(event);
    }
    armIdleExit();
  }

  if (idleTimer) clearTimeout(idleTimer);
  return seen;
}

export async function runMemory(
  argv: string[],
  buildRuntime: BuildRuntime,
  agentPath?: string,
  watchOptions: MemoryWatchOptions = {},
): Promise<void> {
  const opts = parseMemoryArgs(argv);
  const userId = opts.user;
  if (!userId) throw new UsageError('--user is required');

  const connection = await resolveHostedConnection(argv);

  if (opts.watch) {
    if (!opts.session) throw new UsageError('--session is required with --watch');
    if (connection) {
      for await (const event of followHostedMemoryEvents(connection, opts.session, opts.token)) {
        if (isMemoryEvent(event)) writeNdjson(event);
      }
      return;
    }
    const wired = sessionStores(opts.store);
    await buildRuntime(opts.session, wired.store, wired.traces, wired.eventLog);
    await watchMemoryEvents(wired.eventLog, opts.session, watchOptions);
    return;
  }

  if (connection) {
    const body = await fetchHostedMemory(connection, userId, opts.token);
    writeJson(body);
    return;
  }

  const path = agentPath ?? opts.agentPath;
  if (!path) throw new UsageError('--agent is required for local memory reads');

  const context = await resolveAgentMemoryContext(path);
  if (!context) {
    throw new UsageError('agent module must export an AgentConfig as `agent` or default');
  }

  const outcome = await readLocalMemory(context, userId);
  if (outcome.status !== 200) {
    throw new UsageError(typeof outcome.body === 'object' && outcome.body && 'error' in outcome.body
      ? String((outcome.body as { error: string }).error)
      : 'memory read failed');
  }
  writeJson(outcome.body);
}
