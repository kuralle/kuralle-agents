/**
 * send — ONE turn against a PERSISTED session for adaptive multi-turn conversations.
 *
 * Flags: --session <id> · --store <file> · --state · --reset · --resume · --respond · --stream
 *        --approve [by] · --deny [by] · --signal <name> [--payload <json>]
 *
 * With --resume, a prior TurnResult on stdin carries the session cursor across process
 * boundaries. --respond answers input-required requests via Session.respond.
 */
import { join } from 'node:path';
import { Command } from 'commander';
import { createClient, reduce, type LoggedEvent, type TurnView } from '@kuralle-agents/client';
import type { BuildRuntime } from './agentRuntime.js';
import { UsageError } from './errors.js';
import { fileSessionStore } from './fileStore.js';
import { fileSessionEventLog } from './fileEventLog.js';
import { fileTraceStore } from './fileTraceStore.js';
import {
  priorView,
  readResumeResult,
  resolveOperation,
  resumeCursor,
  type ResolvedSend,
} from './resolveOperation.js';
import { buildTurnResult, type TurnResult } from './turnResult.js';

interface SendOptions {
  session: string;
  user?: string;
  store: string;
  reset?: boolean;
  state?: boolean;
  resume?: boolean;
  respond?: string;
  stream?: boolean;
  approve?: string | boolean;
  deny?: string | boolean;
  signal?: string;
  payload?: string;
}

export interface SendHooks {
  onEvent?: (event: LoggedEvent) => void;
}

function sendCommand(): Command {
  return new Command('send')
    .option('--session <id>', 'session id', 'default')
    .option('--user <id>', 'user id for scoped memory')
    .option('--store <file>', 'persist session + traces')
    .option('--reset', 'delete the session and exit')
    .option('--state', 'print session state and exit')
    .option('--resume', 'continue from a TurnResult piped on stdin')
    .option('--respond <json>', 'answer input-required requests')
    .option('--stream', 'emit NDJSON LoggedEvent lines, then the TurnResult')
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
  previousView?: TurnView,
): Promise<TurnResult> {
  const tail = await eventLog.tail(sessionId);
  const { events } = await eventLog.read(sessionId, 0);
  const view = reduce(events, previousView);
  return buildTurnResult(sessionId, { ...view, cursor: tail });
}

async function collectTurn(
  turn: AsyncIterable<LoggedEvent> & { result(): Promise<unknown> },
  hooks?: SendHooks,
): Promise<void> {
  if (!hooks) {
    await turn.result();
    return;
  }
  for await (const event of turn) {
    hooks.onEvent?.(event);
    if (event.part.type === 'error') break;
  }
  await turn.result();
}

function sessionIdFor(resolved: ResolvedSend, fallback: string): string {
  return resolved.previous ? resumeCursor(resolved.previous).sessionId : fallback;
}

export async function runSend(
  argv: string[],
  buildRuntime: BuildRuntime,
  hooks?: SendHooks,
): Promise<TurnResult> {
  const { opts, message } = parseSendArgs(argv);
  const previous = await readResumeResult(opts.resume === true);
  const approve = opts.approve !== undefined;
  const deny = opts.deny !== undefined;
  const signalName = opts.signal;
  const by = (typeof opts.approve === 'string' ? opts.approve : undefined)
    ?? (typeof opts.deny === 'string' ? opts.deny : undefined)
    ?? 'cli';
  const doReset = opts.reset === true;
  const doState = opts.state === true;

  if (doReset || doState) {
    const sessionId = previous ? resumeCursor(previous).sessionId : opts.session;
    const storePath = opts.store;
    const store = fileSessionStore(storePath);
    const base = storePath.replace(/\.json$/, '');
    const traces = fileTraceStore(`${base}.traces.jsonl`);
    const eventLog = fileSessionEventLog(`${base}.events.jsonl`);
    await buildRuntime(sessionId, store, traces, eventLog);

    if (doReset) {
      await store.delete(sessionId);
      const view = reduce([], priorView(previous));
      return {
        status: 'completed',
        message: `reset session "${sessionId}"`,
        cursor: { sessionId, index: -1 },
        view,
      };
    }
    return snapshotView(sessionId, eventLog, priorView(previous));
  }

  const resolved = resolveOperation(
    message,
    opts.respond,
    approve,
    deny,
    signalName,
    previous,
  );
  const sessionId = sessionIdFor(resolved, opts.session);
  const userId = opts.user;
  const storePath = opts.store;

  const store = fileSessionStore(storePath);
  const base = storePath.replace(/\.json$/, '');
  const traces = fileTraceStore(`${base}.traces.jsonl`);
  const eventLog = fileSessionEventLog(`${base}.events.jsonl`);
  const demo = await buildRuntime(sessionId, store, traces, eventLog);
  const client = createClient({ kind: 'local', runtime: demo.runtime, eventLog });
  const session = resolved.previous
    ? client.sessions.attach(sessionId, resumeCursor(resolved.previous))
    : client.sessions.attach(sessionId);

  const fromIndex = resolved.previous
    ? resumeCursor(resolved.previous).index + 1
    : (await eventLog.tail(sessionId)) + 1;

  let turn;
  if (resolved.mode === 'respond') {
    turn = await session.respond(resolved.responses!, userId ? { userId } : undefined);
  } else if (resolved.mode === 'signal') {
    const requestId = previous?.status === 'input-required'
      ? previous.requests[0]?.requestId ?? ''
      : '';
    if (approve || deny) {
      turn = await session.respond([{
        requestId,
        decision: approve ? 'approve' : 'deny',
        actor: { id: by, type: 'user' },
      }], userId ? { userId } : undefined);
    } else {
      turn = await session.respond([{
        requestId,
        signalName,
        payload: JSON.parse(opts.payload ?? '{}') as Record<string, unknown>,
        actor: { id: 'cli', type: 'service' },
      }], userId ? { userId } : undefined);
    }
  } else {
    turn = await session.send(message, userId ? { userId } : undefined);
  }

  await collectTurn(turn, hooks);

  const { events } = await eventLog.read(sessionId, fromIndex);
  const view = reduce(events, priorView(resolved.previous));
  return buildTurnResult(sessionId, view);
}
