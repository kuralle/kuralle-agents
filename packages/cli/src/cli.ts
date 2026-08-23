#!/usr/bin/env node
/**
 * kuralle — Kuralle CLI for agent send, simulation, trace inspection, and deployment.
 *
 *   kuralle send --session <id> [--user <id>] [--store <file>] [--state|--reset] "<message>"
 *   kuralle resume <session> [--store <file>] [--summary <text>]
 *   kuralle memory --user <id> [--session <id>] [--watch] [--store <file>]
 *   kuralle cancel --session <id> [--store <file>]
 *   kuralle history --session <id> [--from <index>] [--store <file>]
 *   kuralle sim --goal "<goal>" [--turns N] [--profile "<who>"] [--agent <path.ts>]
 *   kuralle trace <session> [--last] [--json] [--web] [--port N]
 *   kuralle connect <server> [--transport http|cloudflare] [--agent-name <name>]
 *   kuralle build --agent <directory> --default-model <provider/model> [--target node|cloudflare]
 *   kuralle start [--app .kuralle/node/server.mjs]
 */
import { Command } from 'commander';
import { loadEnvFile } from '@kuralle-agents/client';
import { resolveBuildRuntime } from './agentLoader.js';
import { AuthRequiredError, UsageError } from './errors.js';
import { runResume } from './resume.js';
import { runSchema } from './schema.js';
import { runSend } from './send.js';
import { runSim } from './sim.js';
import { runTrace } from './trace.js';
import {
  clearHostedConnection,
  connectionFromArgs,
  readHostedConnection,
  saveHostedConnection,
} from './hostedConnection.js';
import { runBuildCommand, runStartCommand } from './buildCommand.js';
import { runCancel } from './cancel.js';
import { runHistory } from './history.js';
import { runMemory } from './memory.js';
import {
  authRequiredResult,
  exitCodeFor,
  writeTurnResult,
} from './turnResult.js';

const CHAT_STUB = 'interactive chat moved to kuralle-tui — install @kuralle-agents/tui (requires Bun)';

function subcommandArgv(name: string): string[] {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv.slice(index + 1) : [];
}

function globalAgentFlags(): { agentPath?: string; modelFlag?: string } {
  const argv = process.argv;
  const agentIndex = argv.indexOf('--agent');
  const modelIndex = argv.indexOf('--model');
  return {
    agentPath: agentIndex >= 0 ? argv[agentIndex + 1] : undefined,
    modelFlag: modelIndex >= 0 ? argv[modelIndex + 1] : undefined,
  };
}

async function main(): Promise<void> {
  // Before anything resolves an agent module: that module reads process.env at import time.
  // Consumed out of argv rather than declared as an option, because every subcommand parses its
  // own slice and would otherwise have to declare it too — one of them forgetting is a bug.
  const envIndex = process.argv.indexOf('--env-file');
  const envPath = envIndex >= 0 ? process.argv[envIndex + 1] : undefined;
  if (envIndex >= 0) process.argv.splice(envIndex, envPath ? 2 : 1);
  loadEnvFile(envPath);

  const program = new Command()
    .name('kuralle')
    .description('Kuralle agent CLI')
    .option('--agent <path.ts>', 'Load a Runtime, defineAgent export, or buildRuntime factory')
    .option('--model <id>', 'OpenAI model id when the agent export has no model (bare-agent shape)')
    .option('--env-file <path>', 'Load environment variables from this file instead of ./.env')
    .showHelpAfterError();

  program
    .command('chat')
    .description('Interactive chat (moved to kuralle-tui)')
    .allowUnknownOption()
    .action(() => {
      process.stderr.write(`${CHAT_STUB}\n`);
      process.exit(2);
    });

  program
    .command('send')
    .description('One turn against a persisted session')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      try {
        const { agentPath, modelFlag } = globalAgentFlags();
        const buildRuntime = await resolveBuildRuntime(agentPath, { modelFlag });
        const argv = subcommandArgv('send');
        const stream = argv.includes('--stream');
        const result = await runSend(argv, buildRuntime, stream ? {
          onEvent: (event) => {
            process.stdout.write(`${JSON.stringify(event)}\n`);
          },
        } : undefined);
        writeTurnResult(result);
        process.exit(exitCodeFor(result.status));
      } catch (err) {
        if (err instanceof UsageError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(2);
        }
        if (err instanceof AuthRequiredError) {
          const result = authRequiredResult(err.message, err.code);
          writeTurnResult(result);
          process.exit(exitCodeFor(result.status));
        }
        throw err;
      }
    });

  program
    .command('schema')
    .description('Print the TurnResult JSON Schema')
    .action(() => {
      runSchema();
    });

  program
    .command('resume')
    .description('Resume a session after human escalation resolution')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      const { agentPath, modelFlag } = globalAgentFlags();
      const buildRuntime = await resolveBuildRuntime(agentPath, { modelFlag });
      await runResume(subcommandArgv('resume'), buildRuntime);
    });

  program
    .command('sim')
    .description('Simulate a multi-turn conversation toward a goal')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      const { agentPath, modelFlag } = globalAgentFlags();
      const buildRuntime = await resolveBuildRuntime(agentPath, { modelFlag });
      await runSim(subcommandArgv('sim'), buildRuntime);
    });

  program
    .command('trace')
    .description('Inspect persisted agent traces')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      const { agentPath, modelFlag } = globalAgentFlags();
      const buildRuntime = await resolveBuildRuntime(agentPath, { modelFlag });
      await runTrace(subcommandArgv('trace'), buildRuntime);
    });

  program
    .command('connect')
    .description('Save a default hosted server connection')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      const connection = await saveHostedConnection(connectionFromArgs(subcommandArgv('connect')));
      process.stdout.write(`Connected to ${connection.transport} ${connection.server}` +
        (connection.agentName ? ` (${connection.agentName})` : '') + '\n');
    });

  program
    .command('connection')
    .description('Show the saved hosted server connection')
    .action(async () => {
      const connection = await readHostedConnection();
      process.stdout.write(connection
        ? `${connection.transport} ${connection.server}${connection.agentName ? ` (${connection.agentName})` : ''}\n`
        : 'No hosted server is connected.\n');
    });

  program
    .command('disconnect')
    .description('Clear the saved hosted server connection')
    .action(async () => {
      process.stdout.write((await clearHostedConnection()) ? 'Disconnected hosted server.\n' : 'No hosted server was connected.\n');
    });

  program
    .command('build')
    .description('Build a deployable agent artifact')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      const result = await runBuildCommand(subcommandArgv('build'));
      process.stdout.write(`Built ${result.artifactDigest} at ${result.outDir}\n`);
      if (result.serverPath) process.stdout.write(`Node server: ${result.serverPath}\n`);
      if (result.workerPath) process.stdout.write(`Cloudflare Worker: ${result.workerPath}\n`);
    });

  program
    .command('start')
    .description('Start a built Node server artifact')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      await runStartCommand(subcommandArgv('start'));
    });

  program
    .command('memory')
    .description('Read working-memory blocks and extracted values')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      try {
        const { agentPath } = globalAgentFlags();
        const buildRuntime = await resolveBuildRuntime(agentPath);
        await runMemory(subcommandArgv('memory'), buildRuntime, agentPath);
      } catch (err) {
        if (err instanceof UsageError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(2);
        }
        throw err;
      }
    });

  program
    .command('cancel')
    .description('Cancel the active turn on a session')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      try {
        const { agentPath } = globalAgentFlags();
        const buildRuntime = await resolveBuildRuntime(agentPath);
        const result = await runCancel(subcommandArgv('cancel'), buildRuntime);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exit(0);
      } catch (err) {
        if (err instanceof UsageError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(2);
        }
        throw err;
      }
    });

  program
    .command('history')
    .description('Print the session TurnView from the event log snapshot')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      try {
        const { agentPath } = globalAgentFlags();
        const buildRuntime = await resolveBuildRuntime(agentPath);
        const view = await runHistory(subcommandArgv('history'), buildRuntime);
        process.stdout.write(`${JSON.stringify(view)}\n`);
      } catch (err) {
        if (err instanceof UsageError) {
          process.stderr.write(`${err.message}\n`);
          process.exit(2);
        }
        throw err;
      }
    });

  // Commander exits 1 on a usage error; the agent contract reserves 1 for a failed turn and 2 for
  // bad invocation, so an agent can tell "you called it wrong" from "the turn failed".
  program.exitOverride((err) => {
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') process.exit(0);
    process.exit(2);
  });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
