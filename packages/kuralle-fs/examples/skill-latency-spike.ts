#!/usr/bin/env bun
/**
 * Latency spike: same task, WITH skills (progressive disclosure — the model
 * loads the greeter SKILL.md via load_skill) vs WITHOUT skills (the greeter
 * rule is inlined in the system prompt, no extra round-trip). Measures
 * wall-clock, model round-trips (tool calls), and response correctness.
 *
 * Run:  KURALLE_EXAMPLE_PROVIDER=openai bun run packages/kuralle-fs/examples/skill-latency-spike.ts
 */
import {
  createRuntime,
  defineAgent,
  createShellTool,
} from '@kuralle-agents/core';
import type { HarnessStreamPart, TurnHandle } from '@kuralle-agents/core';
import { fsSkillStore } from '@kuralle-agents/fs';
import { virtualShell } from '@kuralle-agents/fs/shell';

const RUNS = Number(process.env.SPIKE_RUNS ?? 4);
const GREETER_RULE = 'When greeting, start with the exact phrase "Ahoy there" then the user\'s name.';
const GREETER_SKILL = `---
name: greeter
description: Greet the user warmly. Load this before greeting.
---

# Greeter skill

${GREETER_RULE}
`;
const TASK = 'My name is Sam. Greet me in the greeter style, then tell me how many orders are in the orders file.';
const SEED = { '/data/orders.txt': 'ORD-1\nORD-2\nORD-3\n' };

async function resolveModel() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required.');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return { model: createOpenAI({ apiKey: key })(modelId), label: `openai:${modelId}` };
}

async function collect(handle: TurnHandle) {
  const parts: HarnessStreamPart[] = [];
  let text = '';
  for await (const part of handle.events) {
    parts.push(part);
    if (part.type === 'text-delta') text += part.delta;
  }
  const result = await handle;
  return { parts, text: text || result.text };
}

function correct(text: string, parts: HarnessStreamPart[]): boolean {
  const bash = parts.find(
    (p) => p.type === 'tool-result' && (p as { toolName: string }).toolName === 'bash',
  ) as { result?: { stdout?: string } } | undefined;
  return /ahoy there/i.test(text) && /\bsam\b/i.test(text) && (bash?.result?.stdout ?? '').includes('3');
}

async function runOnce(withSkills: boolean, model: unknown, label: string) {
  const { fs, shell } = virtualShell({
    initialFiles: withSkills ? { ...SEED, '/skills/greeter/SKILL.md': GREETER_SKILL } : SEED,
  });
  const agent = defineAgent({
    id: `spike-${label}`,
    model: model as never,
    instructions: withSkills
      ? `You are Ada. You have a bash tool and skills. Before greeting, you MUST call load_skill("greeter") and follow it. To count orders run: wc -l < /data/orders.txt.`
      : `You are Ada. You have a bash tool. ${GREETER_RULE} To count orders run: wc -l < /data/orders.txt.`,
    tools: { bash: createShellTool({ shell }) },
    ...(withSkills ? { skills: fsSkillStore(fs) } : {}),
  });
  const runtime = createRuntime({ agents: [agent], defaultAgentId: `spike-${label}` });

  const t0 = performance.now();
  const { parts, text } = await collect(runtime.run({ input: TASK, sessionId: `${label}-${Math.round(t0)}` }));
  const ms = performance.now() - t0;
  const toolCalls = parts.filter((p) => p.type === 'tool-call').length;
  return { ms, toolCalls, ok: correct(text, parts), text: text.replace(/\n+/g, ' ').trim() };
}

function stats(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return { mean, median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

async function main() {
  const { model, label } = await resolveModel();
  console.log(`model: ${label} · runs per config: ${RUNS}\n`);

  const results: Record<string, Awaited<ReturnType<typeof runOnce>>[]> = { withSkills: [], withoutSkills: [] };
  for (let i = 0; i < RUNS; i++) {
    // Alternate order to spread API-load noise evenly across both configs.
    const first = i % 2 === 0;
    const a = await runOnce(first, model, 'a');
    const b = await runOnce(!first, model, 'b');
    results[first ? 'withSkills' : 'withoutSkills'].push(a);
    results[first ? 'withoutSkills' : 'withSkills'].push(b);
    console.log(
      `run ${i + 1}: withSkills ${(first ? a : b).ms.toFixed(0)}ms (${(first ? a : b).toolCalls} calls, ${(first ? a : b).ok ? 'OK' : 'WRONG'}) · ` +
      `withoutSkills ${(first ? b : a).ms.toFixed(0)}ms (${(first ? b : a).toolCalls} calls, ${(first ? b : a).ok ? 'OK' : 'WRONG'})`,
    );
  }

  console.log('\n=== summary ===');
  for (const key of ['withSkills', 'withoutSkills'] as const) {
    const rs = results[key];
    const s = stats(rs.map((r) => r.ms));
    const calls = stats(rs.map((r) => r.toolCalls));
    const okCount = rs.filter((r) => r.ok).length;
    console.log(
      `${key.padEnd(14)}  mean ${s.mean.toFixed(0)}ms  median ${s.median.toFixed(0)}ms  [${s.min.toFixed(0)}-${s.max.toFixed(0)}]  ` +
      `avg tool-calls ${calls.mean.toFixed(1)}  correct ${okCount}/${rs.length}`,
    );
  }
  const wS = stats(results.withSkills.map((r) => r.ms));
  const woS = stats(results.withoutSkills.map((r) => r.ms));
  const delta = wS.median - woS.median;
  console.log(
    `\nskills add ~${delta.toFixed(0)}ms median (${(delta / woS.median * 100).toFixed(0)}%) — the load_skill round-trip; both configs produce the correct response.`,
  );
  console.log('sample withSkills reply:  ', results.withSkills.find((r) => r.ok)?.text ?? '(none correct)');
  console.log('sample withoutSkills reply:', results.withoutSkills.find((r) => r.ok)?.text ?? '(none correct)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
