/**
 * resume — hand a held-over session back to the bot after a human resolved an escalation.
 *
 * Usage: kuralle resume <session> [--store <path>] [--summary <text>]
 *
 * A terminal-handoff escalation parks the run (`status = 'paused'`, no `waitingFor`); every
 * later turn is held with "a colleague is handling this" until this command runs.
 * `runtime.resumeFromEscalation` appends the resolution note, clears the parked flow /
 * escalation state, and marks the run runnable — the next `run()` continues with context.
 */
import { join } from 'node:path';
import type { BuildRuntime } from './agentRuntime.js';
import { fileSessionStore } from './fileStore.js';
import { fileTraceStore } from './fileTraceStore.js';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runResume(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  const storePath = flag(argv, '--store') ?? join(process.cwd(), 'runs/tui-sessions.json');
  const summary = flag(argv, '--summary');

  // Every flag whose VALUE must not be mistaken for the session id positional. Missing one
  // here would let the value survive the filter and become the session id (see send.ts).
  const consumesValue = new Set(['--store', '--summary']);
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && consumesValue.has(argv[i - 1]!)));
  const sessionId = positional[0];

  if (!sessionId) {
    console.error('usage: kuralle resume <session> [--store <path>] [--summary <text>]');
    process.exit(2);
  }

  const store = fileSessionStore(storePath);
  const traces = fileTraceStore(storePath.replace(/\.json$/, '') + '.traces.json');
  const demo = await buildRuntime(sessionId, store, traces);

  await demo.runtime.resumeFromEscalation(
    sessionId,
    summary !== undefined ? { resolutionSummary: summary } : undefined,
  );
  console.log(`resumed session "${sessionId}"${summary ? ` (${summary})` : ''}`);
}
