#!/usr/bin/env bun
/**
 * Runtime latency + scheduling benchmark — deterministic, offline, no API key.
 *
 *     bun packages/core/examples/latency-bench/bench.ts --label before
 *     bun packages/core/examples/latency-bench/bench.ts --label after
 *     bun packages/core/examples/latency-bench/bench.ts --compare before after
 *
 * WHY A MOCK MODEL. This measures *our* runtime overhead, not a provider's
 * variance. Every scenario drives `MockLanguageModelV3` with fixed inter-chunk
 * delays, so a before/after delta is attributable to a framework change rather
 * than to whatever the network was doing. A live-provider benchmark cannot
 * discriminate a 40ms scheduling change from ordinary jitter.
 *
 * METRICS
 *   ttft_ms       first `text-delta` reaching the client channel
 *   ttfs_ms       first *speakable* sentence — the TTFA proxy (see below)
 *   turn_ms       until `await handle` resolves; includes run-close work
 *   done_part_ms  when the `done` StreamPart arrives
 *   close_tail_ms turn_ms - done_part_ms — work the user waits on AFTER the
 *                 stream looks finished. Post-turn memory ingest lives here.
 *   peak_tool_concurrency   highest simultaneous tool executions observed
 *   tool_result_order       order tool results reached the transcript
 *   prompt_chars_by_step    transcript growth across model calls
 *
 * ON TTFA. This repository has no audio path — voice was extracted to a
 * separate repo, and `ls packages/` confirms no realtime-audio / voice-protocol
 * package remains. A literal time-to-first-audio is therefore not measurable
 * here and is NOT reported. `ttfs_ms` is the honest proxy: a cascaded TTS
 * pipeline cannot synthesise until it has a complete utterance, so time-to-
 * first-sentence is the exact quantity that gates first audio. Whatever the
 * runtime shaves off `ttfs_ms` it shaves off TTFA downstream.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';
import type { StreamPart } from '../../src/types/stream.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, 'runs');

// ---------------------------------------------------------------------------
// Simulated provider timing. Fixed so runs are comparable across machines.
// ---------------------------------------------------------------------------
const PROVIDER_FIRST_BYTE_MS = 20;
const PROVIDER_CHUNK_MS = 5;
const TOOL_WORK_MS = 40;
const MEMORY_INGEST_MS = 150;

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

type FinishUnified = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';

function finishChunk(unified: FinishUnified) {
  return { type: 'finish' as const, usage: USAGE, finishReason: { unified, raw: undefined } };
}

function textChunks(deltas: string[], unified: FinishUnified = 'stop') {
  const id = 'txt';
  return [
    { type: 'stream-start' as const, warnings: [] as const },
    { type: 'text-start' as const, id },
    ...deltas.map((delta) => ({ type: 'text-delta' as const, id, delta })),
    { type: 'text-end' as const, id },
    finishChunk(unified),
  ];
}

function toolCallChunks(calls: Array<{ id: string; name: string; input: unknown }>) {
  return [
    { type: 'stream-start' as const, warnings: [] as const },
    ...calls.map((c) => ({
      type: 'tool-call' as const,
      toolCallId: c.id,
      toolName: c.name,
      input: JSON.stringify(c.input),
    })),
    finishChunk('tool-calls'),
  ];
}

/** A model that plays a fixed script, one entry per step. */
function scriptedModel(script: Array<ReturnType<typeof textChunks>>) {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const chunks = script[Math.min(step, script.length - 1)]!;
      step += 1;
      return {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: PROVIDER_FIRST_BYTE_MS,
          chunkDelayInMs: PROVIDER_CHUNK_MS,
        }),
      } as never;
    },
  });
}

// ---------------------------------------------------------------------------
// Instrumented tools
// ---------------------------------------------------------------------------
let inFlight = 0;
let peakInFlight = 0;

function resetConcurrency(): void {
  inFlight = 0;
  peakInFlight = 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parallel-safe read tool with a fixed cost, tracking observed concurrency. */
const read_record = defineTool({
  name: 'read_record',
  description: 'Read one record by id.',
  input: z.object({ id: z.string() }),
  parallelSafe: true,
  replay: false,
  execute: async ({ id }) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      await sleep(TOOL_WORK_MS);
      return { id, value: `record-${id}` };
    } finally {
      inFlight -= 1;
    }
  },
});

/** Returns a deliberately oversized payload — the transcript-growth probe. */
const dump_archive = defineTool({
  name: 'dump_archive',
  description: 'Dump the archive.',
  input: z.object({ n: z.number().optional() }),
  parallelSafe: true,
  replay: false,
  execute: async () => ({
    rows: Array.from({ length: 900 }, (_, i) => ({
      i,
      body: `archive row ${i} ` + 'lorem ipsum dolor sit amet consectetur adipiscing. '.repeat(6),
    })),
  }),
});

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------
interface ScenarioResult {
  scenario: string;
  ok: boolean;
  error?: string;
  ttft_ms: number | null;
  ttfs_ms: number | null;
  done_part_ms: number | null;
  turn_ms: number;
  close_tail_ms: number | null;
  peak_tool_concurrency: number;
  tool_result_order: string[];
  prompt_chars_by_step: number[];
  abnormal_finish_observed: boolean;
  /** Client-channel `error` parts. Above 8-way tool concurrency the session
   *  store's CAS rejects concurrent writes and surfaces "Stale write for
   *  session …" here — the results still land, but the user sees the noise. */
  client_errors: number;
  client_error_samples: string[];
  part_counts: Record<string, number>;
  text: string;
}

/** A TTS pipeline can start once a full sentence exists. This is that moment. */
const SENTENCE_END = /[.!?](\s|$)/;

async function measure(
  scenario: string,
  build: () => { runtime: ReturnType<typeof createRuntime>; input: string },
  jsonl: string[],
): Promise<ScenarioResult> {
  resetConcurrency();
  const partCounts: Record<string, number> = {};
  const toolResultOrder: string[] = [];
  const promptCharsByStep: number[] = [];
  let ttft: number | null = null;
  let ttfs: number | null = null;
  let donePart: number | null = null;
  let abnormal = false;
  let text = '';
  let clientErrors = 0;
  const clientErrorSamples: string[] = [];

  const { runtime, input } = build();
  const t0 = performance.now();

  try {
    // userId is required for memory preload/ingest to engage at all — without it
    // the ingest scenario silently measures nothing.
    const handle = runtime.run({ sessionId: newSessionId(), input, userId: 'bench-user' });

    for await (const part of handle.events as AsyncIterable<StreamPart>) {
      const at = performance.now() - t0;
      partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;
      jsonl.push(JSON.stringify({ scenario, at_ms: Number(at.toFixed(2)), ...part }));

      if (part.type === 'text-delta') {
        const delta = (part.payload as { delta: string }).delta;
        if (ttft === null) ttft = at;
        text += delta;
        if (ttfs === null && SENTENCE_END.test(text)) ttfs = at;
      }
      if (part.type === 'tool-result' && !(part.payload as { preliminary?: boolean }).preliminary) {
        toolResultOrder.push(String((part.payload as { toolCallId?: string }).toolCallId ?? ''));
      }
      if (part.type === 'model-call-start') {
        promptCharsByStep.push(0); // filled below from the model-call-end usage if present
      }
      // A turn that ended abnormally should be visible on the stream. Before the
      // finish-reason work this never fires, which is exactly the point.
      if (part.type === 'turn-incomplete') abnormal = true;
      if (part.type === 'error') {
        clientErrors += 1;
        const msg = String((part.payload as { error?: unknown }).error ?? '');
        if (clientErrorSamples.length < 2) clientErrorSamples.push(msg.slice(0, 120));
      }
      if (part.type === 'done') donePart = at;
    }

    await handle;
    const turn = performance.now() - t0;

    return {
      scenario,
      ok: true,
      ttft_ms: round(ttft),
      ttfs_ms: round(ttfs),
      done_part_ms: round(donePart),
      turn_ms: round(turn)!,
      close_tail_ms: donePart === null ? null : round(turn - donePart),
      peak_tool_concurrency: peakInFlight,
      tool_result_order: toolResultOrder,
      prompt_chars_by_step: promptCharsByStep,
      abnormal_finish_observed: abnormal,
      client_errors: clientErrors,
      client_error_samples: clientErrorSamples,
      part_counts: partCounts,
      text,
    };
  } catch (error) {
    return {
      scenario,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ttft_ms: round(ttft),
      ttfs_ms: round(ttfs),
      done_part_ms: round(donePart),
      turn_ms: round(performance.now() - t0)!,
      close_tail_ms: null,
      peak_tool_concurrency: peakInFlight,
      tool_result_order: toolResultOrder,
      prompt_chars_by_step: promptCharsByStep,
      abnormal_finish_observed: abnormal,
      client_errors: clientErrors,
      client_error_samples: clientErrorSamples,
      part_counts: partCounts,
      text,
    };
  }
}

function round(v: number | null): number | null {
  return v === null ? null : Number(v.toFixed(2));
}

function runtimeWith(
  model: ReturnType<typeof scriptedModel>,
  opts: { tools?: Record<string, ReturnType<typeof defineTool>>; memoryIngest?: boolean } = {},
) {
  const agent = defineAgent({
    id: 'bench',
    name: 'Bench',
    instructions: 'Answer briefly.',
    model,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.memoryIngest ? { memory: { ingest: { enabled: true } } } : {}),
    limits: { maxSteps: 6 },
  } as Parameters<typeof defineAgent>[0]);

  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
    ...(opts.memoryIngest
      ? {
          // Stands in for the post-turn extraction model call. The number is
          // arbitrary; what matters is whether the user waits for it.
          memoryService: {
            addSessionToMemory: async () => {
              await sleep(MEMORY_INGEST_MS);
            },
            searchMemory: async () => ({ memories: [] }),
            deleteMemories: async () => {},
          },
        }
      : {}),
  } as Parameters<typeof createRuntime>[0]);
}

// ---------------------------------------------------------------------------
// Scenarios — each targets a specific change under test
// ---------------------------------------------------------------------------
const SENTENCES = ['Your order ', 'is on ', 'its way. ', 'It arrives ', 'Tuesday.'];

const SCENARIOS: Record<string, () => { runtime: ReturnType<typeof createRuntime>; input: string }> = {
  /** Floor for TTFT / TTFS with nothing else in the way. */
  'text-only': () => ({
    runtime: runtimeWith(scriptedModel([textChunks(SENTENCES)])),
    input: 'Where is my order?',
  }),

  /** 12 parallel-safe calls in one batch — probes the concurrency ceiling and
   *  the order results reach the transcript. */
  'tools-parallel-12': () => ({
    runtime: runtimeWith(
      scriptedModel([
        toolCallChunks(
          Array.from({ length: 12 }, (_, i) => ({
            id: `call-${i}`,
            name: 'read_record',
            input: { id: String(i) },
          })),
        ) as never,
        textChunks(SENTENCES),
      ]),
      { tools: { read_record } },
    ),
    input: 'Read all twelve records.',
  }),

  /** One oversized tool result — probes transcript growth into the next step. */
  'tool-huge-result': () => ({
    runtime: runtimeWith(
      scriptedModel([
        toolCallChunks([{ id: 'call-dump', name: 'dump_archive', input: {} }]) as never,
        textChunks(SENTENCES),
      ]),
      { tools: { dump_archive } },
    ),
    input: 'Summarise the archive.',
  }),

  /** Post-turn memory ingest — probes what the user waits for after `done`. */
  'memory-ingest': () => ({
    runtime: runtimeWith(scriptedModel([textChunks(SENTENCES)]), { memoryIngest: true }),
    input: 'My name is Mithushan and I live in Colombo.',
  }),

  /** Output-limit truncation — probes whether an abnormal finish is visible. */
  'finish-length': () => ({
    runtime: runtimeWith(
      scriptedModel([textChunks(['Your order is on its wa'], 'length')]),
      {},
    ),
    input: 'Write a long answer.',
  }),
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
function pct(before: number | null, after: number | null): string {
  if (before === null || after === null || before === 0) return '—';
  const d = ((after - before) / before) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

function compare(a: string, b: string): void {
  const readSummary = (label: string) => {
    const p = join(RUNS, `${label}.summary.json`);
    if (!existsSync(p)) throw new Error(`no baseline at ${p} — run with --label ${label} first`);
    return JSON.parse(readFileSync(p, 'utf8')) as { results: ScenarioResult[] };
  };
  const before = readSummary(a);
  const after = readSummary(b);
  const byName = new Map(after.results.map((r) => [r.scenario, r]));

  const rows: string[] = [];
  rows.push(`| scenario | metric | ${a} | ${b} | Δ |`);
  rows.push('| --- | --- | ---: | ---: | ---: |');
  for (const bef of before.results) {
    const aft = byName.get(bef.scenario);
    if (!aft) continue;
    const metric = (name: string, x: number | null, y: number | null) =>
      rows.push(`| ${bef.scenario} | ${name} | ${x ?? '—'} | ${y ?? '—'} | ${pct(x, y)} |`);
    metric('ttft_ms', bef.ttft_ms, aft.ttft_ms);
    metric('ttfs_ms', bef.ttfs_ms, aft.ttfs_ms);
    metric('turn_ms', bef.turn_ms, aft.turn_ms);
    metric('close_tail_ms', bef.close_tail_ms, aft.close_tail_ms);
    if (bef.peak_tool_concurrency || aft.peak_tool_concurrency) {
      rows.push(
        `| ${bef.scenario} | peak_concurrency | ${bef.peak_tool_concurrency} | ${aft.peak_tool_concurrency} | ${pct(bef.peak_tool_concurrency, aft.peak_tool_concurrency)} |`,
      );
    }
    if (bef.client_errors || aft.client_errors) {
      rows.push(
        `| ${bef.scenario} | client_errors | ${bef.client_errors} | ${aft.client_errors} | ${bef.client_errors === aft.client_errors ? '—' : 'changed'} |`,
      );
    }
    if (bef.abnormal_finish_observed !== aft.abnormal_finish_observed) {
      rows.push(
        `| ${bef.scenario} | abnormal_finish_visible | ${bef.abnormal_finish_observed} | ${aft.abnormal_finish_observed} | changed |`,
      );
    }
  }
  const md = rows.join('\n');
  console.log(md);
  writeFileSync(join(RUNS, `compare-${a}-${b}.md`), `${md}\n`);
}

async function main(): Promise<void> {
  mkdirSync(RUNS, { recursive: true });
  const argv = process.argv.slice(2);

  const cmpAt = argv.indexOf('--compare');
  if (cmpAt >= 0) {
    compare(argv[cmpAt + 1] ?? 'before', argv[cmpAt + 2] ?? 'after');
    return;
  }

  const labelAt = argv.indexOf('--label');
  const label = labelAt >= 0 ? (argv[labelAt + 1] ?? 'run') : 'run';

  const jsonl: string[] = [];
  const results: ScenarioResult[] = [];
  for (const [name, build] of Object.entries(SCENARIOS)) {
    const r = await measure(name, build, jsonl);
    results.push(r);
    const flag = r.ok ? '' : `  ERROR: ${r.error}`;
    console.log(
      `${name.padEnd(20)} ttft=${String(r.ttft_ms).padStart(7)}  ttfs=${String(r.ttfs_ms).padStart(7)}  turn=${String(r.turn_ms).padStart(7)}  tail=${String(r.close_tail_ms).padStart(7)}  peak=${r.peak_tool_concurrency}  errs=${r.client_errors}${flag}`,
    );
  }

  writeFileSync(join(RUNS, `${label}.jsonl`), `${jsonl.join('\n')}\n`);
  writeFileSync(
    join(RUNS, `${label}.summary.json`),
    `${JSON.stringify({ label, generatedBy: 'latency-bench', results }, null, 2)}\n`,
  );
  console.log(`\nwrote ${join(RUNS, `${label}.jsonl`)} and ${label}.summary.json`);
}

await main();
