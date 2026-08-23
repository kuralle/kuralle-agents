/**
 * send — ONE turn against a PERSISTED session for adaptive multi-turn conversations.
 *
 * Flags: --session <id> · --store <file> · --state · --reset
 *        --approve [by] · --deny [by] · --signal <name> [--payload <json>]
 *
 * A `needsApproval` tool suspends the run durably. Without a way to deliver the decision the
 * CLI could enter that pause and never leave it — every later turn re-requested approval and
 * paused again. The runtime already accepted `signalDelivery`; only the CLI could not send one.
 */
import { join } from 'node:path';
import { Command } from 'commander';
import { createClient, reduce } from '@kuralle-agents/client';
import type { BuildRuntime } from './agentRuntime.js';
import { UsageError } from './errors.js';
import { fileSessionStore } from './fileStore.js';
import { fileSessionEventLog } from './fileEventLog.js';
import { fileTraceStore } from './fileTraceStore.js';
import { buildTurnResult, type TurnResult } from './turnResult.js';

interface SendOptions {
  session: string;
  user?: string;
  store: string;
  reset?: boolean;
  state?: boolean;
  approve?: string | boolean;
  deny?: string | boolean;
  signal?: string;
  payload?: string;
}

function sendCommand(): Command {
  return new Command('send')
    .option('--session <id>', 'session id', 'default')
    .option('--user <id>', 'user id for scoped memory')
    .option('--store <file>', 'persist session + traces')
    .option('--reset', 'delete the session and exit')
    .option('--state', 'print session state and exit')
    .option('--approve [by]', 'approve a pending tool')
    .option('--deny [by]', 'deny a pending tool')
    .option('--signal <name>', 'deliver a named signal')
    .option('--payload <json>', 'signal payload JSON')
    .option('--server <url>', 'hosted server URL')
    .option('--transport <kind>', 'hosted transport')
    .option('--agent-name <name>', 'hosted agent name')
    .option('--token <token>', 'hosted bearer token')
    .option('--model <id>', 'model override')
    .option('--agent <path>', 'agent module path')
    .option('--summary <text>', 'ignored on send')
    .option('--auto <script>', 'ignored on send')
    .option('--trace', 'ignored on send')
    .option('--local', 'ignore hosted connection')
    .argument('[message...]', 'message text');
}

export function parseSendArgs(argv: string[]): { opts: SendOptions; message: string } {
  const cmd = sendCommand();
  cmd.parse(argv, { from: 'user' });
  const opts = cmd.opts<SendOptions>();
  opts.store ??= join(process.cwd(), 'runs/tui-sessions.json');
  return { opts, message: cmd.args.join(' ').trim() };
}

/** Flag values must never become message text — exercised by packages/cli/test/hosted-commands.test.ts */
export function messageFrom(argv: string[]): string {
  return parseSendArgs(argv).message;
}

async function snapshotView(
  sessionId: string,
  eventLog: Awaited<ReturnType<typeof fileSessionEventLog>>,
): Promise<TurnResult> {
  const tail = await eventLog.tail(sessionId);
  const { events } = await eventLog.read(sessionId, 0);
  const view = reduce(events);
  return buildTurnResult(sessionId, { ...view, cursor: tail });
}

export async function runSend(argv: string[], buildRuntime: BuildRuntime): Promise<TurnResult> {
  const { opts, message } = parseSendArgs(argv);
  const sessionId = opts.session;
  // Without this the CLI could not exercise user-scoped memory at all: preload,
  // extractors and the USER block are all skipped when a session has no userId
  // (deliberately — a placeholder owner would pool every anonymous session).
  const userId = opts.user;
  const storePath = opts.store;
  const doReset = opts.reset === true;
  const doState = opts.state === true;
  const approve = opts.approve !== undefined;
  const deny = opts.deny !== undefined;
  const signalName = opts.signal;
  const by = (typeof opts.approve === 'string' ? opts.approve : undefined)
    ?? (typeof opts.deny === 'string' ? opts.deny : undefined)
    ?? 'cli';
  const store = fileSessionStore(storePath);
  const stored = await store.get(sessionId);
  const waitingFor = (
    stored as {
      durableRuns?: Record<
        string,
        { runState?: { waitingFor?: { requestId?: string; signalName?: string } } }
      >;
    }
  )?.durableRuns?.[sessionId]?.runState?.waitingFor;

  // Traces must be file-backed too. `send` is one turn per process, so a MemoryTraceStore
  // (what the loader defaults to whenever a session store is supplied) is discarded on
  // exit and `kuralle trace --store` finds nothing — the exact sidecar `chat --store`
  // writes and the CLI guide promises for both commands.
  const base = storePath.replace(/\.json$/, '');
  const traces = fileTraceStore(`${base}.traces.jsonl`);
  const eventLog = fileSessionEventLog(`${base}.events.jsonl`);
  const demo = await buildRuntime(sessionId, store, traces, eventLog);
  const client = createClient({ kind: 'local', runtime: demo.runtime, eventLog });
  const session = client.sessions.attach(sessionId);

  if (doReset) {
    await store.delete(sessionId);
    const view = reduce([]);
    return {
      status: 'completed',
      message: `reset session "${sessionId}"`,
      cursor: { sessionId, index: -1 },
      view,
    };
  }

  const hasSignal = approve || deny || signalName;
  if (doState) {
    return snapshotView(sessionId, eventLog);
  }

  if (!message && !hasSignal) {
    throw new UsageError('pass a message to take a turn, or --state to inspect');
  }

  let turn;
  const fromIndex = (await eventLog.tail(sessionId)) + 1;
  if (approve || deny) {
    turn = await session.respond([{
      requestId: waitingFor?.requestId ?? '',
      decision: approve ? 'approve' : 'deny',
      actor: { id: by, type: 'user' },
    }], userId ? { userId } : undefined);
  } else if (signalName) {
    turn = await session.respond([{
      requestId: waitingFor?.requestId ?? '',
      signalName,
      payload: JSON.parse(opts.payload ?? '{}') as Record<string, unknown>,
      actor: { id: 'cli', type: 'service' },
    }], userId ? { userId } : undefined);
  } else {
    turn = await session.send(message, userId ? { userId } : undefined);
  }

  await turn.result();
  const { events } = await eventLog.read(sessionId, fromIndex);
  const view = reduce(events);
  return buildTurnResult(sessionId, view);
}
