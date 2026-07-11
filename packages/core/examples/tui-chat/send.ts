#!/usr/bin/env bun
/**
 * send — ONE turn against a PERSISTED session, so you (or an agent driving from the
 * outside) can have an ADAPTIVE multi-turn conversation: send a message, READ the
 * reply, then send the next message you choose based on it. State (history, flow
 * position, journal) lives in a JSON file between calls.
 *
 *   bun examples/tui-chat/send.ts --session s1 "what's today's special?"
 *   bun examples/tui-chat/send.ts --session s1 "order a latte for Friday"
 *   bun examples/tui-chat/send.ts --session s1 "no, make it Saturday"      # read the reply, adapt
 *   bun examples/tui-chat/send.ts --session s1 --state                      # inspect state, no turn
 *   bun examples/tui-chat/send.ts --session s1 --reset                      # wipe this session
 *
 * Flags: --session <id> (default "default") · --store <file> (default runs/tui-sessions.json)
 * Output: the streamed reply, a compact [events] line, and a [state] line (flow · epoch · done).
 * Provider: OpenAI gpt-4.1-mini (needs OPENAI_API_KEY).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import { buildDemoRuntime } from './demoAgent.js';
import { fileSessionStore } from './fileStore.js';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const sessionId = flag('--session') ?? 'default';
const storePath = flag('--store') ?? join(here, '../../../../runs/tui-sessions.json');
const doReset = argv.includes('--reset');
const doState = argv.includes('--state');
// the message = the last non-flag, non-flag-value arg
const reserved = new Set(['--session', sessionId, '--store', storePath]);
const message = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && (argv[i - 1] === '--session' || argv[i - 1] === '--store'))).join(' ').trim();

const store = fileSessionStore(storePath);
const demo = buildDemoRuntime(sessionId, store);

async function readState() {
  const s = await store.get(sessionId);
  const rs = (s as unknown as { durableRuns?: Record<string, { runState?: { activeFlow?: string; runEpoch?: number; state?: Record<string, unknown> } }> })?.durableRuns?.[sessionId]?.runState;
  return `[state] flow=${rs?.activeFlow ?? 'none'} · epoch=${rs?.runEpoch ?? 0} · done=${JSON.stringify((rs?.state as Record<string, unknown> | undefined)?.__completedFlows ?? [])} · turns=${(s?.messages ?? []).filter((m) => m.role === 'user').length}`;
}

if (doReset) {
  await store.delete(sessionId);
  console.log(`reset session "${sessionId}"`);
  process.exit(0);
}
if (doState || !message) {
  console.log(await readState());
  if (!message && !doState) console.error('(no message — pass one to take a turn, or --state to inspect)');
  process.exit(0);
}

const events: string[] = [];
const handle = demo.runtime.run({ sessionId, input: message });
let text = '';
for await (const part of handle.events as AsyncIterable<HarnessStreamPart>) {
  if (part.type === 'text-delta') { text += part.delta; process.stdout.write(part.delta); }
  else if (part.type === 'tool-call') events.push(`tool:${part.toolName}`);
  else if (part.type === 'flow-enter') events.push(`enter:${part.flow}`);
  else if (part.type === 'flow-end') events.push(`end:${part.flow}`);
  else if (part.type === 'handoff') events.push(`handoff:${part.targetAgent}`);
  else if (part.type === 'paused') events.push(`paused:${(part as { waitingFor?: string }).waitingFor ?? ''}`);
  else if (part.type === 'error') events.push(`error:${(part as { error?: unknown }).error}`);
}
const res = await handle;
if (!text && typeof (res as { text?: string }).text === 'string') text = (res as { text: string }).text;
if (!text.endsWith('\n')) process.stdout.write('\n');
if (events.length) console.log(`[events] ${events.join(' ')}`);
console.log(await readState());
