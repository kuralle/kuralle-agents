/**
 * Meridian Bank — Agent Plugin + MCP + Policy boundary, live.
 *
 * Skill teaches limits and fraud messaging; MCP tools execute account operations; Policy
 * gates every tool call (`allow` / `ask` / `deny`). This example proves REQ-10 end-to-end
 * against a real model turn.
 *
 * Run:
 *   set -a; . ./.env; set +a
 *   bun packages/plugins/examples/banking.ts
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
  readOnlyPolicy,
  type Policy,
  type SkillStoreLike,
  type TurnHandle,
} from '@kuralle-agents/core';
import { MemoryStore } from '@kuralle-agents/core/session';
import type { SessionStore } from '@kuralle-agents/core/session';
import { SessionRunStore } from '../../core/dist/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../core/dist/runtime/openRun.js';
import { NodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { mcpTools } from '@kuralle-agents/mcp';
import { loadAgentPlugin } from '@kuralle-agents/plugins';
import type { StreamPart } from '@kuralle-agents/core/types';
import {
  bankingTools,
  startExampleMcpServer,
  type ExampleServerHandle,
} from '../../mcp/examples/_server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, 'meridian-bank');
const MCP_PORT = 39217;
const TRANSFER_TOOL = 'meridian__transfer_funds';
const READ_TOOLS = new Set([
  'meridian__get_balance',
  'meridian__list_transactions',
  'meridian__find_payee',
]);

function resolveLiveModel(): LanguageModel {
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) return createXai({ apiKey: xaiKey })('grok-3');
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (googleKey) {
    return createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.0-flash');
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return createOpenAI({ apiKey: openaiKey })('gpt-4o-mini');
  throw new Error('No provider API key found — set XAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or OPENAI_API_KEY');
}

function transferAskPolicy(): Policy {
  return {
    decide: (req) =>
      req.toolName === TRANSFER_TOOL || req.toolName.endsWith('__transfer_funds')
        ? { kind: 'ask', title: 'Approve Meridian Bank transfer?' }
        : { kind: 'allow' },
  };
}

interface TurnTrace {
  toolCalls: string[];
  events: Array<'paused' | `tool-result:${string}`>;
  readCompleted: boolean;
  transferPaused: boolean;
  interruptRequestId?: string;
}

async function collectTurn(handle: TurnHandle): Promise<TurnTrace> {
  const trace: TurnTrace = {
    toolCalls: [],
    events: [],
    readCompleted: false,
    transferPaused: false,
  };

  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'tool-call') {
      trace.toolCalls.push(part.payload.toolName);
    }
    if (part.type === 'tool-result') {
      trace.events.push(`tool-result:${part.payload.toolName}`);
      if (READ_TOOLS.has(part.payload.toolName)) {
        trace.readCompleted = true;
      }
    }
    if (part.type === 'paused') {
      trace.events.push('paused');
      if (part.payload.waitingFor === '__approval') {
        trace.transferPaused = true;
        trace.interruptRequestId = part.payload.interrupt.requestId;
      }
    }
  }
  await handle;
  return trace;
}

function readCompletedWithoutApproval(trace: TurnTrace): boolean {
  const firstReadResultIdx = trace.events.findIndex(
    (event) => event.startsWith('tool-result:') && READ_TOOLS.has(event.slice('tool-result:'.length)),
  );
  if (firstReadResultIdx === -1) return false;
  return !trace.events.slice(0, firstReadResultIdx).includes('paused');
}

function fail(message: string, failures: string[]): void {
  failures.push(message);
}

async function runReadOnlyDenial(
  model: LanguageModel,
  remoteTools: Awaited<ReturnType<typeof mcpTools>>,
  pluginSkills: SkillStoreLike,
  server: ExampleServerHandle,
  failures: string[],
): Promise<void> {
  const callsBefore = server.calls().length;
  const sessionId = `meridian-deny-${Date.now()}`;
  const agent = defineAgent({
    id: 'meridian-deny',
    model,
    instructions:
      'You are a Meridian Bank assistant. When asked to transfer funds, call transfer_funds immediately with the ids and amount given.',
    tools: remoteTools,
    skills: pluginSkills,
    policy: readOnlyPolicy([TRANSFER_TOOL]),
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'meridian-deny',
    defaultModel: model,
  });

  const trace = await collectTurn(
    runtime.run({
      sessionId,
      input:
        'Transfer exactly $25 from Meridian Bank account chk-001 to payee id payee-1. ' +
        'Use the meridian__transfer_funds tool now — do not ask for confirmation.',
    }),
  );

  if (server.calls().length !== callsBefore) {
    fail(
      `assertion 4: read-only policy — server.calls() must stay empty (got ${server.calls().length - callsBefore} new call(s): ${JSON.stringify(server.calls().slice(callsBefore))})`,
      failures,
    );
  }

  const attemptedTransfer = trace.toolCalls.includes(TRANSFER_TOOL);
  if (!attemptedTransfer) {
    fail('assertion 4: model never attempted meridian__transfer_funds under read-only policy', failures);
  }
}

async function runApprovalFlow(
  model: LanguageModel,
  remoteTools: Awaited<ReturnType<typeof mcpTools>>,
  pluginSkills: SkillStoreLike,
  server: ExampleServerHandle,
  sessionStore: SessionStore,
  failures: string[],
): Promise<void> {
  const sessionId = `meridian-approve-${Date.now()}`;
  const runId = sessionDerivedRunId(sessionId);
  const agent = defineAgent({
    id: 'meridian-teller',
    model,
    instructions: [
      'You are a Meridian Bank customer-service agent.',
      'Before any transfer, load the transfer-limits skill and follow its caps.',
      'Use MCP tools for all account reads and transfers — skills teach policy, tools execute.',
      'When the customer requests a transfer, check balance first, then transfer the exact amount asked.',
    ].join(' '),
    tools: remoteTools,
    skills: pluginSkills,
    policy: transferAskPolicy(),
  });
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'meridian-teller',
    defaultModel: model,
    sessionStore,
  });

  const callsBeforeTransferPhase = server.calls().length;

  const trace = await collectTurn(
    runtime.run({
      sessionId,
      input:
        'For Meridian Bank account chk-001 (Avery Finch): load the transfer-limits skill first, ' +
        'then check the current balance with get_balance, then transfer exactly $50 to Northwind Utilities ' +
        '(use find_payee with query "Northwind" to get the payee id, then transfer_funds from chk-001).',
    }),
  );

  const loadIndex = trace.toolCalls.indexOf('load_skill');
  const transferIndex = trace.toolCalls.indexOf(TRANSFER_TOOL);
  if (loadIndex === -1 || transferIndex === -1 || loadIndex >= transferIndex) {
    fail(
      `assertion 1: load_skill must precede transfer (calls: ${trace.toolCalls.join(' → ')})`,
      failures,
    );
  }

  if (!readCompletedWithoutApproval(trace)) {
    fail('assertion 2: read MCP tool did not complete without an approval prompt', failures);
  }

  if (!trace.transferPaused || !trace.interruptRequestId) {
    fail('assertion 3: transfer_funds did not suspend the turn for approval', failures);
    return;
  }

  if (server.calls().some((c) => c.tool === 'transfer_funds')) {
    fail('assertion 3: transfer reached MCP server before approval', failures);
  }

  const runStore = new SessionRunStore(sessionStore, sessionId);
  const stepsBeforeResume = await runStore.getSteps(runId);
  const transferStepsBefore = stepsBeforeResume.filter(
    (step) => step.kind === 'tool' && step.name === TRANSFER_TOOL,
  );
  if (transferStepsBefore.length !== 0) {
    fail(
      `assertion 3: journal must have zero transfer entries while suspended (got ${transferStepsBefore.length})`,
      failures,
    );
  }

  await collectTurn(
    runtime.run({
      sessionId,
      signalDelivery: {
        signalId: `sig-${sessionId}`,
        requestId: trace.interruptRequestId,
        name: '__approval',
        actor: { id: 'supervisor', type: 'user' },
        decision: 'approve',
      },
    }),
  );

  const transferStepsAfter = (await runStore.getSteps(runId)).filter(
    (step) => step.kind === 'tool' && step.name === TRANSFER_TOOL,
  );
  if (transferStepsAfter.length !== 1) {
    fail(
      `assertion 3: journal must hold exactly one transfer entry after approval (got ${transferStepsAfter.length})`,
      failures,
    );
  }

  const transferCalls = server
    .calls()
    .slice(callsBeforeTransferPhase)
    .filter((c) => c.tool === 'transfer_funds');
  if (transferCalls.length !== 1) {
    fail(
      `assertion 3: MCP server must record exactly one transfer_funds call (got ${transferCalls.length})`,
      failures,
    );
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const model = resolveLiveModel();
  let server: ExampleServerHandle | undefined;

  try {
    server = await startExampleMcpServer({
      port: MCP_PORT,
      tools: bankingTools(),
      record: true,
    });

    const fs = new NodeFileSystem(dirname(PLUGIN_DIR));
    const loaded = await loadAgentPlugin(fs, '/meridian-bank');
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

    const remoteTools = await mcpTools(loaded.plugin.mcpServers, {
      allowedHosts: ['127.0.0.1'],
    });
    if (!remoteTools[TRANSFER_TOOL]) {
      fail(`missing ${TRANSFER_TOOL} in MCP tool map`, failures);
    }

    const sessionStore = new MemoryStore();

    await runReadOnlyDenial(model, remoteTools, loaded.plugin.skills, server, failures);
    await runApprovalFlow(
      model,
      remoteTools,
      loaded.plugin.skills,
      server,
      sessionStore,
      failures,
    );

    if (failures.length > 0) {
      console.error('FAILED:');
      for (const f of failures) console.error('  -', f);
      process.exit(1);
    }

    console.log(
      'PASS — Meridian Bank plugin: skill-before-transfer, read-without-approval, ' +
        'transfer ask/resume exactly-once, read-only deny with zero MCP calls.',
    );
  } finally {
    await server?.close();
  }
}

await main();
