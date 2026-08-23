/**
 * sim — drive simulateConversation with a persona toward a goal and print the transcript.
 */
import { join } from 'node:path';
import { Command } from 'commander';
import { simulateConversation, createJudge } from '@kuralle-agents/core';
import { createClient } from '@kuralle-agents/client';
import type { BuildRuntime } from './agentRuntime.js';
import { demoModel } from './demoAgent.js';
import { fileSessionEventLog } from './fileEventLog.js';

function simCommand(): Command {
  return new Command('sim')
    .requiredOption('--goal <goal>', 'persona goal')
    .option('--turns <n>', 'max turns', '10')
    .option('--profile <who>', 'persona profile', 'a customer chatting with the agent')
    .option('--agent <path>', 'agent module path');
}

function parseSimArgs(argv: string[]): { goal: string; maxTurns: number; profile: string } | undefined {
  const cmd = simCommand();
  try {
    cmd.parse(argv, { from: 'user' });
  } catch {
    return undefined;
  }
  const opts = cmd.opts<{ goal: string; turns: string; profile: string }>();
  const maxTurns = Number.parseInt(opts.turns, 10);
  if (!Number.isFinite(maxTurns) || maxTurns < 1) {
    console.error('--turns must be a positive integer');
    process.exit(2);
  }
  return { goal: opts.goal, maxTurns, profile: opts.profile };
}

export async function runSim(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  const parsed = parseSimArgs(argv);
  if (!parsed) {
    console.error('Usage: kuralle sim --goal "<persona goal>" [--turns N] [--profile "<who>"] [--agent <path.ts>]');
    process.exit(2);
  }
  const { goal, maxTurns, profile } = parsed;

  const model = demoModel();
  const defaultStore = join(process.cwd(), 'runs/tui-sessions.json');
  const eventLog = fileSessionEventLog(defaultStore.replace(/\.json$/, '') + '.events.jsonl');
  const demo = await buildRuntime();
  createClient({ kind: 'local', runtime: demo.runtime, eventLog });
  const persona = { profile, goal, temperament: 'brief and direct' };

  console.log(`Simulating: ${profile}`);
  console.log(`Goal: ${goal}`);
  console.log(`Max turns: ${maxTurns}\n`);

  const result = await simulateConversation({
    runtime: demo.runtime,
    persona,
    userModel: model,
    maxTurns,
    sessionId: demo.sessionId,
  });

  for (const turn of result.transcript) {
    const label = turn.role === 'user' ? 'You' : 'Agent';
    console.log(`${label}: ${turn.content}\n`);
  }

  console.log(`— ended by: ${result.endedBy} · turns: ${result.turns} · tools: ${result.toolsCalled.join(', ') || 'none'} —`);

  const judge = createJudge({ model });
  const verdict = await judge.judge(result, persona);
  console.log(`Judge: overall=${verdict.overall.toFixed(1)} pass=${verdict.pass} — ${verdict.summary}`);
}
