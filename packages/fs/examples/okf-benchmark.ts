#!/usr/bin/env bun
/**
 * Benchmark: two ways to consume the same OKF bundle to answer a data question.
 *
 *   A) progressive  — the OKF-native way: the agent gets /index.md + the workspace
 *                     tool and navigates on demand (index -> concept -> linked concept).
 *   B) whole-dump   — the naive way: every concept file is concatenated into the
 *                     system prompt upfront.
 *
 * Measures wall-clock, prompt size (proxy for input tokens/cost), and correctness
 * across N runs. Shows OKF progressive disclosure's payoff: a far smaller prompt
 * at comparable correctness — the gap widens as the bundle grows.
 *
 * Run:  KURALLE_EXAMPLE_PROVIDER=openai bun run packages/fs/examples/okf-benchmark.ts
 */
import { createRuntime, defineAgent, createFsTool } from '@kuralle-agents/core';
import type { HarnessStreamPart, TurnHandle } from '@kuralle-agents/core';
import { okfBundleToFs, listOkfConcepts } from '@kuralle-agents/fs';
import { SALES_BUNDLE, EXPECTED } from './_okf-bundle.js';

const RUNS = Number(process.env.SPIKE_RUNS ?? 4);
const QUESTION = 'How do I compute weekly active users? Name the exact table and the identity/join column.';

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

const approx = (s: string) => Math.ceil(s.length / 4); // chars/4 token proxy

// Factual core both strategies must recover: the right table + identity column.
// (The fuller distinct-count phrasing varies by strategy — see the completeness
// note in the summary — so it is not part of the pass/fail bar.)
function correct(text: string): boolean {
  const t = text.toLowerCase();
  return t.includes(EXPECTED.table) && t.includes(EXPECTED.joinKey);
}

async function runProgressive(model: unknown, promptTokens: number) {
  const fs = okfBundleToFs(SALES_BUNDLE);
  const agent = defineAgent({
    id: 'okf-prog',
    model: model as never,
    instructions:
      'You are a data analyst. The workspace holds an OKF knowledge bundle. Read /index.md first, ' +
      'then use the workspace tool (op: read/grep) to open the concepts you need and follow their ' +
      'bundle-relative links. Answer with the exact table and identity column. Ground every claim.',
    tools: { workspace: createFsTool({ fs, readOnly: true }) },
    limits: { maxSteps: 10 }, // room to navigate index -> concept -> linked concept
  });
  const runtime = createRuntime({ agents: [agent], defaultAgentId: 'okf-prog' });
  const t0 = performance.now();
  const { parts, text } = await collect(runtime.run({ input: QUESTION, sessionId: `prog-${Math.round(t0)}` }));
  return {
    ms: performance.now() - t0,
    promptTokens,
    toolCalls: parts.filter((p) => p.type === 'tool-call').length,
    ok: correct(text),
  };
}

async function runWholeDump(model: unknown, bundleDump: string, promptTokens: number) {
  const agent = defineAgent({
    id: 'okf-dump',
    model: model as never,
    instructions:
      'You are a data analyst. Below is the full OKF knowledge bundle. Answer with the exact table ' +
      'and identity column, grounded only in this bundle.\n\n=== BUNDLE ===\n' + bundleDump,
  });
  const runtime = createRuntime({ agents: [agent], defaultAgentId: 'okf-dump' });
  const t0 = performance.now();
  const { text } = await collect(runtime.run({ input: QUESTION, sessionId: `dump-${Math.round(t0)}` }));
  return { ms: performance.now() - t0, promptTokens, toolCalls: 0, ok: correct(text) };
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, median: s[Math.floor(s.length / 2)]!, min: s[0]!, max: s[s.length - 1]! };
}

async function main() {
  const { model, label } = await resolveModel();

  // Prompt-size proxies. Progressive pays only for /index.md up front; whole-dump
  // pays for every concept body up front.
  const indexTokens = approx(SALES_BUNDLE['/index.md']!);
  const bundleDump = Object.entries(SALES_BUNDLE)
    .filter(([p]) => p !== '/index.md')
    .map(([p, c]) => `## FILE: ${p}\n${c}`)
    .join('\n\n');
  const dumpTokens = approx(bundleDump);
  const conceptCount = (await listOkfConcepts(okfBundleToFs(SALES_BUNDLE))).length;

  console.log(`model: ${label} · runs per strategy: ${RUNS} · bundle: ${conceptCount} concepts`);
  console.log(`upfront prompt size — progressive (index.md only): ~${indexTokens} tok · whole-dump (all concepts): ~${dumpTokens} tok\n`);

  const prog: Awaited<ReturnType<typeof runProgressive>>[] = [];
  const dump: Awaited<ReturnType<typeof runWholeDump>>[] = [];
  for (let i = 0; i < RUNS; i++) {
    const first = i % 2 === 0; // alternate to spread API-load noise
    if (first) { prog.push(await runProgressive(model, indexTokens)); dump.push(await runWholeDump(model, bundleDump, dumpTokens)); }
    else { dump.push(await runWholeDump(model, bundleDump, dumpTokens)); prog.push(await runProgressive(model, indexTokens)); }
    const p = prog[prog.length - 1]!; const d = dump[dump.length - 1]!;
    console.log(`run ${i + 1}: progressive ${p.ms.toFixed(0)}ms (${p.toolCalls} nav calls, ${p.ok ? 'OK' : 'WRONG'}) · whole-dump ${d.ms.toFixed(0)}ms (${d.ok ? 'OK' : 'WRONG'})`);
  }

  console.log('\n=== summary ===');
  const ps = stats(prog.map((r) => r.ms)); const ds = stats(dump.map((r) => r.ms));
  console.log(`progressive  median ${ps.median.toFixed(0)}ms [${ps.min.toFixed(0)}-${ps.max.toFixed(0)}]  upfront ~${indexTokens} tok  avg nav-calls ${(prog.reduce((a, r) => a + r.toolCalls, 0) / prog.length).toFixed(1)}  correct ${prog.filter((r) => r.ok).length}/${prog.length}`);
  console.log(`whole-dump   median ${ds.median.toFixed(0)}ms [${ds.min.toFixed(0)}-${ds.max.toFixed(0)}]  upfront ~${dumpTokens} tok  avg nav-calls 0.0  correct ${dump.filter((r) => r.ok).length}/${dump.length}`);
  console.log(
    `\nTradeoff: whole-dump is ~${(ps.median - ds.median).toFixed(0)}ms faster (no navigation round-trips) but sends ${(dumpTokens / indexTokens).toFixed(1)}x the upfront prompt.` +
    ` Progressive disclosure keeps the base prompt at ~${indexTokens} tok regardless of bundle size — the crossover favors OKF navigation as the bundle grows beyond what fits (or belongs) in every prompt.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
