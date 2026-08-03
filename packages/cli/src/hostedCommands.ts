import { createInterface } from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';
import type { HostedConnection } from './hostedConnection.js';
import { runHostedTurn } from './hostedClient.js';

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function token(argv: string[]): string | undefined {
  return flag(argv, '--token') || process.env.KURALLE_TOKEN;
}

function session(argv: string[]): string {
  return flag(argv, '--session') || `cli-${crypto.randomUUID()}`;
}

export function messageFrom(argv: string[]): string {
  // Value-consuming flags accepted by cli.ts that must not become message text. Keep in sync
  // with the Options block in packages/cli/src/cli.ts (--store/--summary were missing → leak).
  const consumesValue = new Set([
    '--session', '--server', '--transport', '--agent-name', '--token', '--auto', '--model', '--agent',
    '--store', '--summary',
  ]);
  return argv
    .filter((value, index) => !value.startsWith('--') && !(index > 0 && consumesValue.has(argv[index - 1]!)))
    .join(' ')
    .trim();
}

async function oneTurn(connection: HostedConnection, sessionId: string, message: string, argv: string[]) {
  const started = performance.now();
  const result = await runHostedTurn(connection, sessionId, message, { token: token(argv) });
  stdout.write(`${result.text || '(no text)'}\n`);
  stdout.write(`[hosted] ${connection.transport} ${connection.server} · session=${sessionId} · total=${Math.round(performance.now() - started)}ms` +
    (result.messageCount !== undefined ? ` · messages=${result.messageCount}` : '') + '\n');
  return result;
}

export async function runHostedSend(argv: string[], connection: HostedConnection): Promise<void> {
  const message = messageFrom(argv);
  if (!message) throw new Error('Hosted send requires a message.');
  await oneTurn(connection, session(argv), message, argv);
}

export async function runHostedChat(argv: string[], connection: HostedConnection): Promise<void> {
  if (argv.includes('--trace')) {
    stderr.write('[hosted] --trace has no effect here: the trace panel only runs with --local.\n');
  }
  const sessionId = session(argv);
  const scripted = flag(argv, '--auto')?.split('|').map((value) => value.trim()).filter(Boolean);
  stdout.write(`Kuralle hosted chat · ${connection.transport} ${connection.server}\nSession ${sessionId}\n`);
  if (scripted?.length) {
    for (const message of scripted) {
      stdout.write(`\nYou  ${message}\nAgent  `);
      await oneTurn(connection, sessionId, message, argv);
    }
    return;
  }

  if (!stdin.isTTY) throw new Error('Interactive hosted chat needs a TTY; use --auto for scripts.');
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const message = (await readline.question('You  ')).trim();
      if (message === '/quit' || message === '/exit') break;
      if (!message) continue;
      stdout.write('Agent  ');
      await oneTurn(connection, sessionId, message, argv);
    }
  } finally {
    readline.close();
  }
}
