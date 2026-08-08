/**
 * Meridian Bank as a chattable agent — the `kuralle` CLI entry point.
 *
 * `banking.ts` is a self-asserting proof: it runs fixed turns and exits 0 or 1. This module
 * is the same agent wired for a human instead, exported as a `buildRuntime` factory so the
 * CLI can drive it:
 *
 *   set -a; . ./.env; set +a
 *   bun packages/cli/dist/cli.js chat --local --agent packages/plugins/examples/meridian-agent.ts
 *
 * Headless (scripted turns, no TTY):
 *
 *   bun packages/cli/dist/cli.js chat --local --agent packages/plugins/examples/meridian-agent.ts \
 *     --auto "what is the balance on chk-001?|transfer $50 from chk-001 to Northwind Utilities"
 *
 * The same tool boundary applies here as in the proof: reads run straight through, and
 * `transfer_funds` is gated by `Policy` with `kind: 'ask'`, so the CLI has to surface an
 * approval before any money moves.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createXai } from '@ai-sdk/xai';
import type { LanguageModel } from 'ai';
import { createRuntime, defineAgent, type Policy, type Runtime } from '@kuralle-agents/core';
import { NodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { mcpTools } from '@kuralle-agents/mcp';
import { loadAgentPlugin } from '@kuralle-agents/plugins';
import {
  bankingTools,
  startExampleMcpServer,
  type ExampleServerHandle,
} from '../../mcp/examples/_server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, 'meridian-bank');

/** Must match `meridian-bank/mcp.json`. A manifest is a static file; it cannot learn a port. */
const MCP_PORT = 39217;

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
    'No provider API key found — run `set -a; . ./.env; set +a` first, or set XAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / OPENAI_API_KEY.',
  );
}

function transferAskPolicy(): Policy {
  return {
    decide: (req) =>
      req.toolName.endsWith('__transfer_funds')
        ? { kind: 'ask', title: 'Approve Meridian Bank transfer?' }
        : { kind: 'allow' },
  };
}

let server: ExampleServerHandle | undefined;

function closeServerOnExit(handle: ExampleServerHandle): void {
  // A chat session ends by Ctrl-C far more often than it ends cleanly, and the port is
  // fixed — so without this the next launch fails to bind and looks like a broken example.
  const close = () => {
    void handle.close();
  };
  process.once('exit', close);
  process.once('SIGINT', () => {
    close();
    process.exit(0);
  });
  process.once('SIGTERM', close);
}

export async function buildRuntime(): Promise<Runtime> {
  const model = resolveLiveModel();

  server = await startExampleMcpServer({
    port: MCP_PORT,
    tools: bankingTools(),
    record: true,
  });
  closeServerOnExit(server);

  const fs = new NodeFileSystem(dirname(PLUGIN_DIR));
  const loaded = await loadAgentPlugin(fs, '/meridian-bank');
  if (!loaded.ok) {
    throw new Error(`loadAgentPlugin rejected: ${loaded.rejection.message}`);
  }
  for (const diagnostic of loaded.plugin.diagnostics) {
    console.warn(`[plugin] ${diagnostic.section} ${diagnostic.origin}: ${diagnostic.message}`);
  }

  const remoteTools = await mcpTools(loaded.plugin.mcpServers, {
    allowedHosts: ['127.0.0.1'],
  });

  const agent = defineAgent({
    id: 'meridian-teller',
    model,
    instructions: [
      'You are a Meridian Bank customer-service agent.',
      'Before any transfer, load the transfer-limits skill and follow its caps.',
      'Use MCP tools for all account reads and transfers — skills teach policy, tools execute.',
      'When the customer requests a transfer, check the balance first, then transfer the exact amount asked.',
      'Accounts are synthetic demo data; chk-001 belongs to Avery Finch.',
    ].join(' '),
    tools: remoteTools,
    skills: loaded.plugin.skills,
    policy: transferAskPolicy(),
  });

  return createRuntime({
    agents: [agent],
    defaultAgentId: 'meridian-teller',
    defaultModel: model,
  });
}
