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
import { Command } from 'commander';
import { createClient } from '@kuralle-agents/client';
import type { BuildRuntime } from './agentRuntime.js';
import { fileSessionStore } from './fileStore.js';
import { fileSessionEventLog } from './fileEventLog.js';
import { fileTraceStore } from './fileTraceStore.js';

function resumeCommand(): Command {
  return new Command('resume')
    .option('--store <file>', 'persist session + traces')
    .option('--summary <text>', 'resolution note appended on resume')
    .argument('<session>', 'session id');
}

function parseResumeArgs(argv: string[]): { sessionId: string; store: string; summary?: string } {
  const cmd = resumeCommand();
  cmd.parse(argv, { from: 'user' });
  const sessionId = cmd.args[0];
  const opts = cmd.opts<{ store?: string; summary?: string }>();
  return {
    sessionId,
    store: opts.store ?? join(process.cwd(), 'runs/tui-sessions.json'),
    summary: opts.summary,
  };
}

export async function runResume(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  const { sessionId, store: storePath, summary } = parseResumeArgs(argv);

  if (!sessionId) {
    console.error('usage: kuralle resume <session> [--store <path>] [--summary <text>]');
    process.exit(2);
  }

  const store = fileSessionStore(storePath);
  const base = storePath.replace(/\.json$/, '');
  const traces = fileTraceStore(`${base}.traces.jsonl`);
  const eventLog = fileSessionEventLog(`${base}.events.jsonl`);
  const demo = await buildRuntime(sessionId, store, traces, eventLog);
  createClient({ kind: 'local', runtime: demo.runtime, eventLog });

  await demo.runtime.resumeFromEscalation(
    sessionId,
    summary !== undefined ? { resolutionSummary: summary } : undefined,
  );
  console.log(`resumed session "${sessionId}"${summary ? ` (${summary})` : ''}`);
}
