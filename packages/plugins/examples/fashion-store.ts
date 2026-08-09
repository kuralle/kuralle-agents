/**
 * Loom & Field — Agent Plugin + MCP + disclosure budget, live.
 *
 * Skill progressive disclosure (size chart in a bundled reference), ~18 fashion MCP tools
 * with schema deferral under a lowered budget, and per-tool failure isolation.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   bun packages/plugins/examples/fashion-store.ts
 *
 * On deferral and why assertion 4 is worth keeping strict.
 *
 * This example once failed about 2 runs in 5. A deferred tool carried a permissive
 * `{ type: 'object' }` schema, so the model got no argument contract at generation time
 * and had to copy the shape out of an `mcp__describe_tool` result. It did that badly,
 * emitting malformed calls such as `loom__get_shipping_estimate with postalPrefix is 941`.
 *
 * Measured here, same prompt and model, only the budget changed:
 *   deferred, bare schema     malformed tool name in 2 of 5 runs
 *   inline   (budget 50_000)  malformed tool name in 0 of 5 runs
 *
 * A deferred tool now keeps its parameter names, types and `required`, and defers only
 * the descriptions and constraints. That holds most of the token saving and restores the
 * contract: 5 of 5 runs pass. Do not loosen assertion 4 — it is the check that caught
 * this, and it is the one that will catch the next regression in deferral.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import {
  createRuntime,
  defineAgent,
  type SkillStoreLike,
  type TurnHandle,
} from '@kuralle-agents/core';
import { NodeFileSystem } from '@kuralle-agents/fs/node/fs';
import {
  composeMcpSystemPrompt,
  estimateTokens,
  mcpTools,
  MCP_DESCRIBE_TOOL,
  type McpToolset,
} from '@kuralle-agents/mcp';
import { loadAgentPlugin } from '@kuralle-agents/plugins';
import type { StreamPart } from '@kuralle-agents/core/types';
import {
  fashionTools,
  startExampleMcpServer,
  type ExampleServerHandle,
} from '../../mcp/examples/_server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, 'loom-and-field');
const MCP_PORT = 39218;
const FAILON_PORT = 39219;

/** The ~18 fashion tools measure ~1,067 tokens when inlined — under the default 20,000 budget.
 *  The design brief cited 1,500 against a ~2,300-token estimate; at the shipped catalogue size
 *  that would still inline, so this example uses 1,000 to make deferral visible. */
const DISCLOSURE_BUDGET = 1_000;

const EXPECTED_SKILLS = ['returns-window', 'sizing-guide'] as const;

/** Appears only inside a tool's full input schema — never in its name or description. */
const SCHEMA_MARKER = 'Zero-based cart line index';

/** Unique to references/size-chart.md — nowhere else in the repo. */
const SIZE_CHART_MARKER = 'LF-CHART-M-CHEST-94.5cm';

const SHIPPING_TOOL = 'loom__get_shipping_estimate';
const STOCK_TOOL = 'loom__check_stock';
const CATEGORIES_TOOL = 'loom__list_categories';

function resolveLiveModel(): LanguageModel {
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) return createXai({ apiKey: xaiKey })('grok-3');
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (googleKey) {
    return createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.0-flash');
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return createOpenAI({ apiKey: openaiKey })('gpt-4o-mini');
  throw new Error(
    'No provider API key found — set XAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or OPENAI_API_KEY',
  );
}

interface TurnTrace {
  toolCalls: string[];
  toolResults: Array<{ toolName: string; ok: boolean; resultText: string }>;
  reply: string;
}

function toolResultFailed(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false;
  const record = result as { error?: boolean; __denied?: boolean };
  return record.error === true || record.__denied === true;
}

async function collectTurn(handle: TurnHandle): Promise<TurnTrace> {
  const trace: TurnTrace = { toolCalls: [], toolResults: [], reply: '' };

  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'text-delta') {
      trace.reply += part.payload.delta ?? '';
    }
    if (part.type === 'tool-call') {
      trace.toolCalls.push(part.payload.toolName);
    }
    if (part.type === 'tool-result') {
      const { toolName, result } = part.payload as {
        toolName: string;
        result?: unknown;
      };
      const resultText =
        typeof result === 'string' ? result : JSON.stringify(result ?? '');
      trace.toolResults.push({
        toolName,
        ok: !toolResultFailed(result),
        resultText,
      });
    }
  }
  await handle;
  return trace;
}

function fail(message: string, failures: string[], trace?: TurnTrace): void {
  if (trace) {
    failures.push(
      `${message} (tool calls: ${trace.toolCalls.join(' → ') || '(none)'}; reply excerpt: ${trace.reply.trim().slice(0, 120) || '(empty)'})`,
    );
  } else {
    failures.push(message);
  }
}

function assertDisclosureBudget(
  tools: McpToolset['tools'],
  failures: string[],
): void {
  const prompt = composeMcpSystemPrompt(tools);
  const tokens = estimateTokens(prompt);

  if (tokens > DISCLOSURE_BUDGET) {
    fail(
      `assertion 3: composed MCP prompt exceeds budget (${tokens} > ${DISCLOSURE_BUDGET})`,
      failures,
    );
  }
  if (prompt.includes(SCHEMA_MARKER)) {
    fail(
      `assertion 3: full input schema marker "${SCHEMA_MARKER}" must be absent when deferred`,
      failures,
    );
  }
  if (!tools[MCP_DESCRIBE_TOOL]) {
    fail('assertion 3: mcp__describe_tool must exist when schemas are deferred', failures);
  }
}

async function runSizingAndDeferral(
  model: LanguageModel,
  remoteTools: McpToolset['tools'],
  pluginSkills: SkillStoreLike,
  failures: string[],
): Promise<void> {
  const listed = await pluginSkills.list();
  const names = listed.map((s) => s.name).sort();
  for (const expected of EXPECTED_SKILLS) {
    if (!names.includes(expected)) {
      fail(`assertion 1: skill "${expected}" not discovered (got: ${names.join(', ')})`, failures);
    }
  }

  const agent = defineAgent({
    id: 'loom-stylist',
    model,
    instructions: [
      'You are a Loom & Field customer stylist.',
      'Load the sizing-guide skill before answering fit questions.',
      'Read bundled skill references with read_skill_resource when the skill names a file.',
      'Use MCP tools for catalogue and shipping facts.',
      'When a tool schema is deferred, call mcp__describe_tool for that tool before calling it.',
    ].join(' '),
    tools: remoteTools,
    skills: pluginSkills,
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'loom-stylist',
    defaultModel: model,
  });

  const trace = await collectTurn(
    runtime.run({
      sessionId: `loom-sizing-${Date.now()}`,
      input: [
        'Follow these steps exactly once, in order, then answer:',
        '1) load_skill with name sizing-guide',
        '2) read_skill_resource with name sizing-guide and path references/size-chart.md',
        '3) mcp__describe_tool with tool loom__get_shipping_estimate',
        '4) loom__get_shipping_estimate with postalPrefix "941"',
        'Quote the exact size M chest cell from the chart file verbatim and report shipping days.',
        'Do not reload skills or re-read the chart.',
      ].join(' '),
    }),
  );

  if (!trace.toolCalls.includes('load_skill')) {
    fail('assertion 1: load_skill was never called', failures, trace);
  }

  if (!trace.toolCalls.includes('read_skill_resource')) {
    fail('assertion 2: read_skill_resource was never called', failures, trace);
  } else if (!trace.reply.includes(SIZE_CHART_MARKER)) {
    fail(
      `assertion 2: reply must include size-chart marker "${SIZE_CHART_MARKER}"`,
      failures,
      trace,
    );
  }

  const describeIndex = trace.toolCalls.indexOf(MCP_DESCRIBE_TOOL);
  const shippingIndex = trace.toolCalls.indexOf(SHIPPING_TOOL);
  if (describeIndex === -1 || shippingIndex === -1 || describeIndex >= shippingIndex) {
    fail(
      'assertion 4: mcp__describe_tool must precede a successful deferred tool call',
      failures,
      trace,
    );
  } else {
    const shippingResult = trace.toolResults.find((r) => r.toolName === SHIPPING_TOOL);
    if (!shippingResult?.ok) {
      fail('assertion 4: loom__get_shipping_estimate did not return a successful result', failures, trace);
    }
  }
}

async function runFailOnIsolation(
  model: LanguageModel,
  remoteTools: McpToolset['tools'],
  failures: string[],
): Promise<void> {
  if (!remoteTools[STOCK_TOOL] || !remoteTools[CATEGORIES_TOOL]) {
    fail('assertion 5: missing loom MCP tools after reconnect', failures);
    return;
  }

  const agent = defineAgent({
    id: 'loom-resilience',
    model,
    instructions:
      'You are a Loom & Field assistant. Call MCP tools by their qualified names when asked.',
    tools: remoteTools,
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'loom-resilience',
    defaultModel: model,
  });

  const trace = await collectTurn(
    runtime.run({
      sessionId: `loom-failon-${Date.now()}`,
      input:
        'Call loom__check_stock with sku lf-wool-coat-01 and size m, then call loom__list_categories with {}. ' +
        'Report whether check_stock errored and list the categories array from list_categories.',
    }),
  );

  const stockResult = trace.toolResults.find((r) => r.toolName === STOCK_TOOL);
  if (!stockResult || stockResult.ok) {
    fail(
      'assertion 5: loom__check_stock must error under failOn while siblings still work',
      failures,
      trace,
    );
  }

  const categoriesResult = trace.toolResults.find((r) => r.toolName === CATEGORIES_TOOL);
  if (!categoriesResult?.ok || !categoriesResult.resultText.includes('outerwear')) {
    fail(
      'assertion 5: loom__list_categories must return a real catalogue result (expected outerwear)',
      failures,
      trace,
    );
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const model = resolveLiveModel();
  let mainServer: ExampleServerHandle | undefined;
  let failOnServer: ExampleServerHandle | undefined;
  const closers: Array<() => Promise<void>> = [];

  try {
    const fs = new NodeFileSystem(dirname(PLUGIN_DIR));
    const loaded = await loadAgentPlugin(fs, '/loom-and-field');
    if (!loaded.ok) {
      fail(`loadAgentPlugin rejected: ${loaded.rejection.message}`, failures);
      throw new Error(failures.join('; '));
    }
    if (loaded.plugin.diagnostics.length > 0) {
      fail(
        `plugin diagnostics: ${loaded.plugin.diagnostics.map((d) => d.message).join('; ')}`,
        failures,
      );
    }

    mainServer = await startExampleMcpServer({
      port: MCP_PORT,
      tools: fashionTools(),
      record: true,
    });

    const { tools: remoteTools, close: closeRemoteTools } = await mcpTools(
      loaded.plugin.mcpServers,
      { allowedHosts: ['127.0.0.1'], disclosure: { budget: DISCLOSURE_BUDGET } },
    );
    closers.push(closeRemoteTools);

    assertDisclosureBudget(remoteTools, failures);
    await runSizingAndDeferral(model, remoteTools, loaded.plugin.skills, failures);

    failOnServer = await startExampleMcpServer({
      port: FAILON_PORT,
      tools: fashionTools(),
      failOn: ['check_stock'],
    });
    const { tools: failOnTools, close: closeFailOnTools } = await mcpTools(
      [{ name: 'loom', type: 'streamable-http', url: failOnServer.url }],
      {
        allowedHosts: ['127.0.0.1'],
        disclosure: { budget: DISCLOSURE_BUDGET },
      },
    );
    closers.push(closeFailOnTools);
    await runFailOnIsolation(model, failOnTools, failures);

    if (failures.length > 0) {
      console.error('FAILED:');
      for (const f of failures) console.error('  -', f);
      process.exit(1);
    }

    console.log(
      'PASS — Loom & Field plugin: skills + size-chart resource, disclosure budget deferral, ' +
        'describe-then-call, and failOn isolation.',
    );
  } finally {
    // A toolset holds live MCP connections until it is closed.
    for (const close of closers) await close();
    await mainServer?.close();
    await failOnServer?.close();
  }
}

await main();
