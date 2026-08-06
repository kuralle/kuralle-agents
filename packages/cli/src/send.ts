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
import type { StreamPart } from '@kuralle-agents/core';
import type { BuildRuntime } from './agentRuntime.js';
import { fileSessionStore } from './fileStore.js';
import { fileTraceStore } from './fileTraceStore.js';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runSend(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  const sessionId = flag(argv, '--session') ?? 'default';
  // Without this the CLI could not exercise user-scoped memory at all: preload,
  // extractors and the USER block are all skipped when a session has no userId
  // (deliberately — a placeholder owner would pool every anonymous session).
  const userId = flag(argv, '--user');
  const storePath = flag(argv, '--store') ?? join(process.cwd(), 'runs/tui-sessions.json');
  const doReset = argv.includes('--reset');
  const doState = argv.includes('--state');
  const approve = argv.includes('--approve');
  const deny = argv.includes('--deny');
  const signalName = flag(argv, '--signal');
  const by = flag(argv, '--approve') ?? flag(argv, '--deny') ?? 'cli';
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
  const signalDelivery =
    approve || deny
      ? {
          signalId: `cli-${Date.now()}`,
          requestId: waitingFor?.requestId ?? '',
          name: '__approval',
          actor: { id: by, type: 'user' as const },
          decision: approve ? 'approve' as const : 'deny' as const,
        }
      : signalName
        ? {
            signalId: `cli-${Date.now()}`,
            requestId: waitingFor?.requestId ?? '',
            name: signalName,
            actor: { id: 'cli', type: 'service' as const },
            payload: JSON.parse(flag(argv, '--payload') ?? '{}') as Record<string, unknown>,
          }
        : undefined;
  // Every flag whose VALUE must not be mistaken for message text. Missing `--model` here
  // meant the model id survived the filter and became the first word of every user turn —
  // a whole live run was sent to the model with "gpt-4.1-mini " prepended to each message.
  const consumesValue = new Set([
    '--session',
    '--store',
    '--model',
    '--signal',
    '--payload',
    '--approve',
    '--deny',
  ]);
  const message = argv
    .filter((a, i) => !a.startsWith('--') && !(i > 0 && consumesValue.has(argv[i - 1]!)))
    .join(' ')
    .trim();

  // Traces must be file-backed too. `send` is one turn per process, so a MemoryTraceStore
  // (what the loader defaults to whenever a session store is supplied) is discarded on
  // exit and `kuralle trace --store` finds nothing — the exact sidecar `chat --store`
  // writes and the CLI guide promises for both commands.
  const traces = fileTraceStore(storePath.replace(/\.json$/, '') + '.traces.json');
  const demo = await buildRuntime(sessionId, store, traces);

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
  // A decision can arrive with no message — approving is itself the turn.
  if (doState || (!message && !signalDelivery)) {
    console.log(await readState());
    if (!message && !doState) console.error('(no message — pass one to take a turn, or --state to inspect)');
    return;
  }

  const events: string[] = [];
  const started = performance.now();
  let ttftMs: number | null = null;
  const handle = demo.runtime.run({
    sessionId,
    input: message,
    ...(userId ? { userId } : {}),
    ...(signalDelivery ? { signalDelivery } : {}),
  });
  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
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
  const res = await handle;
  if (!text && typeof (res as { text?: string }).text === 'string') text = (res as { text: string }).text;
  if (!text.endsWith('\n')) process.stdout.write('\n');
  if (events.length) console.log(`[events] ${events.join(' ')}`);
  console.log(
    `[timing] TTFT=${ttftMs === null ? 'none' : `${Math.round(ttftMs)}ms`} ` +
    `total=${Math.round(performance.now() - started)}ms`,
  );
  console.log(await readState());
}
