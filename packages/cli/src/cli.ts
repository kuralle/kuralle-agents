#!/usr/bin/env bun
/**
 * kuralle — Kuralle CLI for interactive chat, adaptive send, and simulation.
 *
 *   kuralle chat [--trace] [--store <file>] [--session <id>] [--auto "msg1|msg2"] [--agent <path.ts>]
 *   kuralle send --session <id> [--user <id>] [--store <file>] [--state|--reset] "<message>"
 *   kuralle resume <session> [--store <file>] [--summary <text>]
 *   kuralle sim --goal "<goal>" [--turns N] [--profile "<who>"] [--agent <path.ts>]
 *   kuralle trace <session> [--last] [--json] [--web] [--port N]
 *   kuralle connect <server> [--transport http|cloudflare] [--agent-name <name>]
 *   kuralle build --agent <directory> --default-model <provider/model> [--target node|cloudflare]
 *   kuralle start [--app .kuralle/node/server.mjs]
 */
import { resolveBuildRuntime } from './agentLoader.js';
import { runChat } from './chat.js';
import { runResume } from './resume.js';
import { runSend } from './send.js';
import { runSim } from './sim.js';
import { runTrace } from './trace.js';
import {
  clearHostedConnection,
  connectionFromArgs,
  readHostedConnection,
  resolveHostedConnection,
  saveHostedConnection,
} from './hostedConnection.js';
import { runHostedChat, runHostedSend } from './hostedCommands.js';
import { runBuildCommand, runStartCommand } from './buildCommand.js';

const HELP = `kuralle — Kuralle agent CLI

Usage:
  kuralle chat [--trace] [--store <file>] [--session <id>] [--auto "msg1|msg2"] [--agent <path.ts>]
  kuralle send --session <id> [--user <id>] [--store <file>] [--state|--reset] "<message>"
  kuralle resume <session> [--store <file>] [--summary <text>]
  kuralle sim --goal "<goal>" [--turns N] [--profile "<who>"] [--agent <path.ts>]
  kuralle trace <session> [--last] [--json] [--web] [--port N]
  kuralle connect <server> [--transport http|cloudflare] [--agent-name <name>]
  kuralle build --agent <directory> --default-model <provider/model> [--target node|cloudflare] [--host deployment.node.ts]
  kuralle build --agent <directory> --target cloudflare --host deployment.cloudflare.ts --d1-id <uuid> [--d1-name <name>] [--r2-bucket <name>]
  kuralle start [--app .kuralle/node/server.mjs]
  kuralle connection
  kuralle disconnect

Options:
  --agent <path.ts>   Load a Runtime, defineAgent export, or buildRuntime factory (local commands only; ignored over a hosted connection)
  --model <id>        OpenAI model id when the agent export has no model (bare-agent shape) (local commands only; ignored over a hosted connection)
  --auto "a|b|c"      Headless scripted turns (chat only)
  --trace             Live trace side panel — the built-in AgentTrace of each turn (--local chat only; ignored over a hosted connection, with a warning)
  --store <file>      Persist the session + traces to JSON files so chat survives across launches (--local chat only; ignored over a hosted connection)
  --session <id>      Session id to resume with --store (default: "default")
  --summary <text>    Resolution note appended on resume (seen by the agent post-resume)
  --server <url>      Use this hosted server for the command (or KURALLE_SERVER)
  --transport <kind>  Hosted transport: http (Next/Hono/Worker JSON) or cloudflare (native Agents WS)
  --agent-name <name> Versioned HTTP deployment entity or Cloudflare Agent URL name
  --token <token>     Per-command bearer/query token; prefer KURALLE_TOKEN to avoid shell history
  --local             Ignore the saved hosted connection and run the local agent

Hosted mode:
  'kuralle connect' saves a default server. Chat and send then use that hosted
  runtime automatically; --local is the explicit escape hatch.
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function stripGlobalFlags(argv: string[]): { rest: string[]; agentPath?: string } {
  const rest: string[] = [];
  let agentPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--agent') {
      agentPath = argv[i + 1];
      i += 1;
      continue;
    }
    rest.push(a);
  }
  return { rest, agentPath };
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.length === 0 || rawArgv.includes('--help') || rawArgv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sub = rawArgv[0];
  const rawSubArgv = rawArgv.slice(1);

  if (sub === 'connect') {
    const connection = await saveHostedConnection(connectionFromArgs(rawSubArgv));
    process.stdout.write(`Connected to ${connection.transport} ${connection.server}` +
      (connection.agentName ? ` (${connection.agentName})` : '') + '\n');
    return;
  }
  if (sub === 'connection') {
    const connection = await readHostedConnection();
    process.stdout.write(connection
      ? `${connection.transport} ${connection.server}${connection.agentName ? ` (${connection.agentName})` : ''}\n`
      : 'No hosted server is connected.\n');
    return;
  }
  if (sub === 'disconnect') {
    process.stdout.write((await clearHostedConnection()) ? 'Disconnected hosted server.\n' : 'No hosted server was connected.\n');
    return;
  }
  if (sub === 'build') {
    const result = await runBuildCommand(rawSubArgv);
    process.stdout.write(`Built ${result.artifactDigest} at ${result.outDir}\n`);
    if (result.serverPath) process.stdout.write(`Node server: ${result.serverPath}\n`);
    if (result.workerPath) process.stdout.write(`Cloudflare Worker: ${result.workerPath}\n`);
    return;
  }
  if (sub === 'start') {
    await runStartCommand(rawSubArgv);
    return;
  }

  if (sub === 'chat' || sub === 'send') {
    const connection = await resolveHostedConnection(rawArgv);
    if (connection) {
      if (sub === 'chat') await runHostedChat(rawSubArgv, connection);
      else await runHostedSend(rawSubArgv, connection);
      return;
    }
  }

  const { rest, agentPath } = stripGlobalFlags(rawArgv);
  const localSub = rest[0];
  const subArgv = rest.slice(1);
  const buildRuntime = await resolveBuildRuntime(agentPath ?? flag(rawArgv, '--agent'), {
    modelFlag: flag(rawArgv, '--model'),
  });

  switch (localSub) {
    case 'chat':
      await runChat(subArgv, buildRuntime);
      break;
    case 'send':
      await runSend(subArgv, buildRuntime);
      break;
    case 'resume':
      await runResume(subArgv, buildRuntime);
      break;
    case 'sim':
      await runSim(subArgv, buildRuntime);
      break;
    case 'trace':
      await runTrace(subArgv, buildRuntime);
      break;
    default:
      console.error(`Unknown command: ${localSub}\n`);
      process.stdout.write(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
