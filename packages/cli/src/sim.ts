/**
 * sim — drive simulateConversation with a persona toward a goal and print the transcript.
 */
import { simulateConversation, createJudge } from '@kuralle-agents/core';
import type { BuildRuntime } from './agentRuntime.js';
import { demoModel } from './demoAgent.js';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runSim(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  const goal = flag(argv, '--goal');
  if (!goal) {
    console.error('Usage: kuralle sim --goal "<persona goal>" [--turns N] [--profile "<who>"] [--agent <path.ts>]');
    process.exit(2);
  }

  const turnsRaw = flag(argv, '--turns');
  const maxTurns = turnsRaw ? Number.parseInt(turnsRaw, 10) : 10;
  if (!Number.isFinite(maxTurns) || maxTurns < 1) {
    console.error('--turns must be a positive integer');
    process.exit(2);
  }

  const profile = flag(argv, '--profile') ?? 'a customer chatting with the agent';
  const model = demoModel();
  const demo = buildRuntime();
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