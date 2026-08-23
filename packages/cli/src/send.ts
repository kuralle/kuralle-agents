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
import type { StreamPart } from '@kuralle-agents/core';
import { createClient } from '@kuralle-agents/client';
import type { BuildRuntime } from './agentRuntime.js';
import { fileSessionStore } from './fileStore.js';
import { fileSessionEventLog } from './fileEventLog.js';
import { fileTraceStore } from './fileTraceStore.js';

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

export async function runSend(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
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
    stored as unknown as {
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

  async function readState() {
    const s = await store.get(sessionId);
    const rs = (s as unknown as { durableRuns?: Record<string, { runState?: { activeFlow?: string; runEpoch?: number; state?: Record<string, unknown> } }> })?.durableRuns?.[sessionId]?.runState;
    return `[state] flow=${rs?.activeFlow ?? 'none'} · epoch=${rs?.runEpoch ?? 0} · done=${JSON.stringify((rs?.state as Record<string, unknown> | undefined)?.__completedFlows ?? [])} · turns=${(s?.messages ?? []).filter((m) => m.role === 'user').length}`;
  }

  if (doReset) {
    await store.delete(sessionId);
    console.log(`reset session "${sessionId}"`);
    return;
  }

  const hasSignal = approve || deny || signalName;
  // A decision can arrive with no message — approving is itself the turn.
  if (doState || (!message && !hasSignal)) {
    console.log(await readState());
    if (!message && !doState) console.error('(no message — pass one to take a turn, or --state to inspect)');
    return;
  }

  const events: string[] = [];
  const started = performance.now();
  let ttftMs: number | null = null;
  let turn;
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

  let text = '';
  for await (const logged of turn) {
    const part = logged.part as StreamPart;
    if (part.type === 'text-delta') {
      if (part.payload.delta && ttftMs === null) ttftMs = performance.now() - started;
      text += part.payload.delta;
      process.stdout.write(part.payload.delta);
    }
    else if (part.type === 'tool-call') events.push(`tool:${part.payload.toolName}`);
    else if (part.type === 'flow-enter') events.push(`enter:${part.payload.flow}`);
    else if (part.type === 'flow-end') events.push(`end:${part.payload.flow}`);
    else if (part.type === 'handoff') events.push(`handoff:${part.payload.targetAgent}`);
    else if (part.type === 'paused') {
      const operation = part.payload.interrupt.operation;
      events.push(
        operation
          ? `approval-pending:${part.payload.interrupt.requestId}:${operation.toolName}`
          : `paused:${part.payload.interrupt.requestId}:${part.payload.waitingFor}`,
      );
    }
    else if (part.type === 'error') events.push(`error:${part.payload.error}`);
  }
  const res = await turn.result();
  if (!text && typeof (res as { text?: string }).text === 'string') text = (res as { text: string }).text;
  if (!text.endsWith('\n')) process.stdout.write('\n');
  if (events.length) console.log(`[events] ${events.join(' ')}`);
  console.log(
    `[timing] TTFT=${ttftMs === null ? 'none' : `${Math.round(ttftMs)}ms`} ` +
    `total=${Math.round(performance.now() - started)}ms`,
  );
  console.log(await readState());
}
