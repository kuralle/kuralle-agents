import { createOpenAI } from '@ai-sdk/openai';
import { createInMemoryOrderLedger } from '../packages/commerce/src/index.ts';
import { createRuntime, type AgentConfig } from '../packages/core/src/index.ts';
import { InMemoryFs } from '../packages/fs/src/index.ts';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCommerceAgent } from '../apps/examples/agentic-commerce-assistant/src/agent.js';
import { buildContentAgent } from '../apps/examples/content-agent/src/agent.js';
import { buildSupportAgent } from '../apps/examples/customer-support-agent/src/agent.js';
import { createDemoSupportBackend } from '../apps/examples/customer-support-agent/src/backend.js';
import { supportConfig } from '../apps/examples/customer-support-agent/support.config.js';
import { buildHealthcareAgent } from '../apps/examples/healthcare/src/agent.js';
import { HealthcareRepository } from '../apps/examples/healthcare/src/database.js';
import { buildHotelReceptionist } from '../apps/examples/hotel-receptionist/src/agent.js';
import { HotelRepository } from '../apps/examples/hotel-receptionist/src/database.js';
import { buildPharmacyAgent } from '../apps/examples/pharmacy-rx-agent/src/agent.js';
import { buildHackerAgent } from '../apps/examples/postgres-hacker-starter/server/agent.js';
import { buildReleaseGovernanceAgent } from '../apps/examples/release-governance-agent/src/agent.js';

const MODEL = 'gpt-4.1-mini';
const PROMPT = 'In one short sentence, introduce yourself and state your scope. Do not call any tool.';

interface SmokeAgent {
  source: string;
  agent: AgentConfig;
  close?: () => void | Promise<void>;
}

function noOpQueryable() {
  return {
    async query() {
      throw new Error('The live identity smoke prompt must not query Postgres');
    },
  };
}

async function agents(model: AgentConfig['model'], scratch: string): Promise<SmokeAgent[]> {
  const healthcare = new HealthcareRepository(':memory:');
  const hotel = new HotelRepository(':memory:');
  const contentFs = new InMemoryFs();
  const pharmacyFs = new InMemoryFs();
  const releaseState = join(scratch, 'release-state');

  return [
    {
      source: 'apps/examples/agentic-commerce-assistant',
      agent: buildCommerceAgent({
        model: model!,
        env: { ENVIRONMENT: 'test' } as never,
        retrieval: {
          async find() {
            throw new Error('The live identity smoke prompt must not search products');
          },
          async getIndexed() { return null; },
        } as never,
        porulle: {
          async getProduct() { return null; },
          async checkout() { throw new Error('Checkout is disabled in the live identity smoke'); },
        },
        ledger: createInMemoryOrderLedger(),
      }),
    },
    {
      source: 'apps/examples/content-agent',
      agent: buildContentAgent(model!, contentFs),
    },
    {
      source: 'apps/examples/customer-support-agent',
      agent: buildSupportAgent({ model: model!, backend: createDemoSupportBackend(), config: supportConfig }),
    },
    {
      source: 'apps/examples/healthcare',
      agent: buildHealthcareAgent(model!, healthcare),
      close: () => healthcare.close(),
    },
    {
      source: 'apps/examples/hotel-receptionist',
      agent: buildHotelReceptionist(model!, hotel),
      close: () => hotel.close(),
    },
    {
      source: 'apps/examples/pharmacy-rx-agent',
      agent: buildPharmacyAgent({ model: model!, notesFileSystem: pharmacyFs }),
    },
    {
      source: 'apps/examples/postgres-hacker-starter',
      agent: buildHackerAgent(model!, new (await import(
        '../apps/examples/postgres-hacker-starter/server/database.js'
      )).HackerRepository(noOpQueryable() as never, async () => [])),
    },
    {
      source: 'apps/examples/release-governance-agent',
      agent: buildReleaseGovernanceAgent({
        model: model!,
        config: {
          repoRoot: resolve(import.meta.dirname, '..'),
          stateRoot: releaseState,
          repository: 'kuralle/kuralle-agents',
          releaseBranch: 'main',
          checks: [{ name: 'smoke', command: ['true'] }],
        },
        skillRoot: resolve(import.meta.dirname, '../apps/examples/release-governance-agent/workspace'),
      }),
    },
  ];
}

async function run(agent: SmokeAgent): Promise<{ text: string; elapsedMs: number }> {
  const runtime = createRuntime({
    agents: [agent.agent],
    defaultAgentId: agent.agent.id,
    defaultModel: agent.agent.model,
  });
  const started = performance.now();
  const handle = runtime.run({
    sessionId: `live-${agent.agent.id}-${crypto.randomUUID()}`,
    userId: 'live-smoke-user',
    input: PROMPT,
  });
  let text = '';
  let toolCalls = 0;
  for await (const part of handle.events) {
    if (part.type === 'text-delta') text += part.payload.delta;
    if (part.type === 'tool-call') toolCalls += 1;
  }
  await handle;
  if (!text.trim()) throw new Error('model returned no text');
  if (toolCalls !== 0) throw new Error(`identity smoke unexpectedly called ${toolCalls} tool(s)`);
  return { text: text.trim(), elapsedMs: Math.round(performance.now() - started) };
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required in the environment or repository .env');
  const model = createOpenAI({ apiKey })(MODEL);
  const scratch = await mkdtemp(join(tmpdir(), 'kuralle-live-agents-'));
  const matrix = await agents(model, scratch);
  const results: Array<{ source: string; agentId: string; model: string; elapsedMs: number; text: string }> = [];
  try {
    const exampleRoot = resolve(import.meta.dirname, '../apps/examples');
    const expectedSources = (await readdir(exampleRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
      .map(entry => `apps/examples/${entry.name}`)
      .sort();
    const coveredSources = matrix.map(item => item.source).sort();
    if (JSON.stringify(coveredSources) !== JSON.stringify(expectedSources)) {
      throw new Error(
        `Live agent matrix is incomplete: expected ${expectedSources.join(', ')}, received ${coveredSources.join(', ')}`,
      );
    }
    for (const item of matrix) {
      const result = await run(item);
      results.push({
        source: item.source,
        agentId: item.agent.id,
        model: MODEL,
        ...result,
      });
      console.log(`PASS ${item.agent.id} (${result.elapsedMs}ms)`);
    }
  } finally {
    for (const item of matrix) await item.close?.();
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ model: MODEL, count: results.length, results }, null, 2));
}

await main();
