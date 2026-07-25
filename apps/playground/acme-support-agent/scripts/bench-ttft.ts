/**
 * TTFT Benchmark — Time To First Token across the full Runtime pipeline.
 *
 * Measures the wall-clock time from `runtime.stream()` call to the first
 * `text-delta` event. This is what the user actually experiences.
 *
 * Breakdown:
 *   Input → Triage routing → Knowledge retrieval → LLM TTFT → first token
 *
 * Usage: bun run scripts/bench-ttft.ts
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import { loadPlaygroundEnv, resolvePlaygroundModel } from '../../_shared/runtime/model.js';
import { mergeHarnessTools } from '../../_shared/runtime/harnessTools.js';
import { buildAgents } from '../src/agents.js';
import { knowledgeConfig } from '../src/knowledge.js';

loadPlaygroundEnv(import.meta.url);
const { model } = resolvePlaygroundModel();
const agentList = buildAgents(model);

const runtime = createRuntime({
  agents: agentList,
  defaultAgentId: 'triage',
  defaultModel: model,
  sessionStore: new MemoryStore(),
  knowledge: knowledgeConfig,
  tools: mergeHarnessTools(agentList),
});

// ── Test Queries ────────────────────────────────────────────────────────────

const queries = [
  { label: 'Single-hop (refund policy)',        input: 'What is the refund policy?' },
  { label: 'Multi-hop (Widget + refund)',        input: 'Can I return the Widget X100 and how long will the refund take?' },
  { label: 'Single-hop (shipping)',              input: 'What are the shipping options and costs?' },
  { label: 'Multi-hop (Pro + backup)',           input: 'Does the Pro Plan include cloud backup, and what does it cost?' },
  { label: 'Off-topic (no KB match)',            input: 'How do I install Python on Windows?' },
  { label: 'Cache hit (repeat Q1)',              input: 'What is the refund policy?' },
];

// ── Types ───────────────────────────────────────────────────────────────────

type EventTiming = {
  type: string;
  offsetMs: number;
  detail?: string;
};

type RunResult = {
  label: string;
  input: string;
  ttftMs: number;
  totalMs: number;
  events: EventTiming[];
  responsePreview: string;
};

// ── Run a single query and measure everything ───────────────────────────────

async function measureQuery(label: string, input: string, sessionId?: string): Promise<{ result: RunResult; sessionId: string }> {
  const sid = sessionId ?? crypto.randomUUID();
  const events: EventTiming[] = [];
  let ttftMs = -1;
  let responseText = '';
  let returnedSessionId = '';

  const start = performance.now();

  const handle = runtime.run({ input, sessionId: sid });

  for await (const event of handle.events) {
    const offset = performance.now() - start;

    switch (event.type) {
      case 'text-delta':
        if (ttftMs < 0) {
          ttftMs = offset;
          events.push({ type: 'TTFT', offsetMs: offset });
        }
        responseText += event.payload.delta;
        break;
      case 'turn-end':
        events.push({ type: 'turn-end', offsetMs: offset });
        break;
      case 'handoff':
        events.push({
          type: 'handoff',
          offsetMs: offset,
          detail: `→ ${event.payload.targetAgent}`,
        });
        break;
      case 'knowledge-cache-hit':
        events.push({
          type: 'cache-hit',
          offsetMs: offset,
          detail: `${event.payload.resultCount} results`,
        });
        break;
      case 'knowledge-cache-miss':
        events.push({ type: 'cache-miss', offsetMs: offset });
        break;
      case 'knowledge-search':
        events.push({
          type: `search(${event.payload.layer})`,
          offsetMs: offset,
          detail: `${event.payload.resultCount} results`,
        });
        break;
      case 'knowledge-quality-check':
        events.push({
          type: `quality(${event.payload.quality})`,
          offsetMs: offset,
          detail: `top=${event.payload.topScore.toFixed(3)}`,
        });
        break;
      case 'knowledge-reformulation':
        events.push({
          type: `reformulate(${event.payload.trigger})`,
          offsetMs: offset,
          detail: `${event.payload.latencyMs}ms`,
        });
        break;
    }
  }

  await handle;

  const totalMs = performance.now() - start;

  return {
    result: {
      label,
      input,
      ttftMs,
      totalMs,
      events,
      responsePreview: responseText.slice(0, 120).replace(/\n/g, ' '),
    },
    sessionId: sid,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Kuralle TTFT Benchmark — Full Round Trip                  ║');
  console.log('║  Input → Triage → Knowledge → LLM → First Token            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const results: RunResult[] = [];
  let sessionId: string | undefined;

  for (const q of queries) {
    process.stdout.write(`  Running: ${q.label}...`);
    const { result, sessionId: sid } = await measureQuery(q.label, q.input, sessionId);
    sessionId = sid;
    results.push(result);
    console.log(` TTFT=${result.ttftMs.toFixed(0)}ms, Total=${result.totalMs.toFixed(0)}ms`);
  }

  // ── Detailed timeline for each query ──────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  EVENT TIMELINES');
  console.log('══════════════════════════════════════════════════════════════════');

  for (const r of results) {
    console.log(`\n  ┌─ ${r.label}`);
    console.log(`  │  Query: "${r.input}"`);
    console.log(`  │`);

    for (const e of r.events) {
      const bar = '█'.repeat(Math.min(Math.round(e.offsetMs / 100), 30));
      const ms = e.offsetMs < 1 ? `${(e.offsetMs * 1000).toFixed(0)}µs` : `${e.offsetMs.toFixed(0)}ms`;
      const detail = e.detail ? ` (${e.detail})` : '';
      const marker = e.type === 'TTFT' ? ' ◄── FIRST TOKEN' : '';
      console.log(`  │  ${ms.padStart(8)}  ${bar} ${e.type}${detail}${marker}`);
    }

    console.log(`  │`);
    console.log(`  │  Response: "${r.responsePreview}..."`);
    console.log(`  └─ TTFT: ${r.ttftMs.toFixed(0)}ms | Total: ${r.totalMs.toFixed(0)}ms`);
  }

  // ── Summary table ─────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  TTFT SUMMARY');
  console.log('══════════════════════════════════════════════════════════════════\n');

  const maxLabel = Math.max(...results.map(r => r.label.length));

  console.log(`  ${'Query'.padEnd(maxLabel)}  ${'TTFT'.padStart(8)}  ${'Total'.padStart(8)}  Timeline`);
  console.log(`  ${'─'.repeat(maxLabel)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(30)}`);

  for (const r of results) {
    const ttft = `${r.ttftMs.toFixed(0)}ms`;
    const total = `${r.totalMs.toFixed(0)}ms`;
    const bar = '▓'.repeat(Math.round(r.ttftMs / 200)) + '░'.repeat(Math.max(0, Math.round((r.totalMs - r.ttftMs) / 200)));
    console.log(`  ${r.label.padEnd(maxLabel)}  ${ttft.padStart(8)}  ${total.padStart(8)}  ${bar}`);
  }

  // ── Latency budget analysis ───────────────────────────────────────────

  const ttfts = results.map(r => r.ttftMs);
  const p50 = ttfts.sort((a, b) => a - b)[Math.floor(ttfts.length / 2)];
  const p95 = ttfts.sort((a, b) => a - b)[Math.floor(ttfts.length * 0.95)];
  const min = Math.min(...ttfts);
  const max = Math.max(...ttfts);
  const avg = ttfts.reduce((a, b) => a + b, 0) / ttfts.length;

  console.log(`\n  TTFT Statistics:`);
  console.log(`    Min:  ${min.toFixed(0)}ms`);
  console.log(`    Avg:  ${avg.toFixed(0)}ms`);
  console.log(`    P50:  ${p50.toFixed(0)}ms`);
  console.log(`    P95:  ${p95.toFixed(0)}ms`);
  console.log(`    Max:  ${max.toFixed(0)}ms`);

  // Breakdown: what percentage is retrieval vs LLM
  console.log(`\n  Breakdown (from event timelines):`);
  for (const r of results) {
    const searchEvent = r.events.find(e => e.type.startsWith('search'));
    const ttftEvent = r.events.find(e => e.type === 'TTFT');
    if (searchEvent && ttftEvent) {
      const retrievalMs = searchEvent.offsetMs;
      const llmMs = ttftEvent.offsetMs - searchEvent.offsetMs;
      const retrievalPct = ((retrievalMs / ttftEvent.offsetMs) * 100).toFixed(0);
      const llmPct = ((llmMs / ttftEvent.offsetMs) * 100).toFixed(0);
      console.log(`    ${r.label.padEnd(maxLabel)}  retrieval=${retrievalMs.toFixed(0)}ms (${retrievalPct}%) → LLM TTFT=${llmMs.toFixed(0)}ms (${llmPct}%)`);
    }
  }

  console.log();
}

main().catch(console.error);
