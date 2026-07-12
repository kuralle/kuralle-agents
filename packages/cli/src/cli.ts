#!/usr/bin/env bun
/**
 * kuralle — Kuralle CLI for interactive chat, adaptive send, and simulation.
 *
 *   kuralle chat [--trace] [--auto "msg1|msg2"] [--agent <path.ts>]
 *   kuralle send --session <id> [--store <file>] [--state|--reset] "<message>"
 *   kuralle sim --goal "<goal>" [--turns N] [--profile "<who>"] [--agent <path.ts>]
 *   kuralle trace <session> [--last] [--json] [--web] [--port N]
 */
import { resolveBuildRuntime } from './agentLoader.js';
import { runChat } from './chat.js';
import { runSend } from './send.js';
import { runSim } from './sim.js';
import { runTrace } from './trace.js';

const HELP = `kuralle — Kuralle agent CLI

Usage:
  kuralle chat [--trace] [--auto "msg1|msg2"] [--agent <path.ts>]
  kuralle send --session <id> [--store <file>] [--state|--reset] "<message>"
  kuralle sim --goal "<goal>" [--turns N] [--profile "<who>"] [--agent <path.ts>]
  kuralle trace <session> [--last] [--json] [--web] [--port N]

Options:
  --agent <path.ts>   Load a custom agent module exporting buildRuntime(sessionId?, store?)
  --auto "a|b|c"      Headless scripted turns (chat only)
  --trace             Live trace side panel — the built-in AgentTrace of each turn (chat only)
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

  const { rest, agentPath } = stripGlobalFlags(rawArgv);
  const sub = rest[0];
  const subArgv = rest.slice(1);
  const buildRuntime = await resolveBuildRuntime(agentPath ?? flag(rawArgv, '--agent'));

  switch (sub) {
    case 'chat':
      runChat(subArgv, buildRuntime);
      break;
    case 'send':
      await runSend(subArgv, buildRuntime);
      break;
    case 'sim':
      await runSim(subArgv, buildRuntime);
      break;
    case 'trace':
      await runTrace(subArgv, buildRuntime);
      break;
    default:
      console.error(`Unknown command: ${sub}\n`);
      process.stdout.write(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
