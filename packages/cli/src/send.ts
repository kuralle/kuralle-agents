/**
 * send — ONE turn against a PERSISTED session for adaptive multi-turn conversations.
 *
 * Flags: --session <id> · --store <file> · --state · --reset
 */
import { join } from 'node:path';
import type { StreamPart } from '@kuralle-agents/core';
import type { BuildRuntime } from './agentRuntime.js';
import { fileSessionStore } from './fileStore.js';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runSend(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  const sessionId = flag(argv, '--session') ?? 'default';
  const storePath = flag(argv, '--store') ?? join(process.cwd(), 'runs/tui-sessions.json');
  const doReset = argv.includes('--reset');
  const doState = argv.includes('--state');
  const reserved = new Set(['--session', sessionId, '--store', storePath]);
  const message = argv
    .filter((a, i) => !a.startsWith('--') && !(i > 0 && (argv[i - 1] === '--session' || argv[i - 1] === '--store')))
    .join(' ')
    .trim();

  const store = fileSessionStore(storePath);
  const demo = buildRuntime(sessionId, store);

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
  if (doState || !message) {
    console.log(await readState());
    if (!message && !doState) console.error('(no message — pass one to take a turn, or --state to inspect)');
    return;
  }

  const events: string[] = [];
  const handle = demo.runtime.run({ sessionId, input: message });
  let text = '';
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') { text += part.payload.delta; process.stdout.write(part.payload.delta); }
    else if (part.type === 'tool-call') events.push(`tool:${part.payload.toolName}`);
    else if (part.type === 'flow-enter') events.push(`enter:${part.payload.flow}`);
    else if (part.type === 'flow-end') events.push(`end:${part.payload.flow}`);
    else if (part.type === 'handoff') events.push(`handoff:${part.payload.targetAgent}`);
    else if (part.type === 'paused') events.push(`paused:${part.payload.waitingFor}`);
    else if (part.type === 'error') events.push(`error:${part.payload.error}`);
  }
  const res = await handle;
  if (!text && typeof (res as { text?: string }).text === 'string') text = (res as { text: string }).text;
  if (!text.endsWith('\n')) process.stdout.write('\n');
  if (events.length) console.log(`[events] ${events.join(' ')}`);
  console.log(await readState());
}
