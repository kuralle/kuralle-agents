import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';

export type HostedTransport = 'http' | 'cloudflare';

export interface HostedConnection {
  server: string;
  transport: HostedTransport;
  agentName?: string;
}

function connectionFlagsCommand(): Command {
  return new Command()
    .option('--server <url>', 'hosted server URL')
    .option('--transport <kind>', 'hosted transport')
    .option('--agent-name <name>', 'hosted agent name')
    .option('--local', 'ignore saved hosted connection')
    .allowUnknownOption()
    .allowExcessArguments();
}

function parseConnectionFlags(argv: string[]): {
  server?: string;
  transport?: string;
  agentName?: string;
  local?: boolean;
} {
  const cmd = connectionFlagsCommand();
  cmd.parse(argv, { from: 'user' });
  return cmd.opts();
}

export function hostedConfigPath(): string {
  if (process.env.KURALLE_CONFIG?.trim()) return process.env.KURALLE_CONFIG.trim();
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configRoot, 'kuralle', 'connection.json');
}

function normalizeServer(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Hosted server must use http:// or https://.');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function parseTransport(value: string | undefined): HostedTransport {
  const normalized = value?.trim().toLowerCase() || 'http';
  if (normalized !== 'http' && normalized !== 'cloudflare') {
    throw new Error(`Unsupported hosted transport "${value}". Use http or cloudflare.`);
  }
  return normalized;
}

function validate(connection: HostedConnection): HostedConnection {
  const normalized = {
    server: normalizeServer(connection.server),
    transport: parseTransport(connection.transport),
    ...(connection.agentName?.trim() ? { agentName: connection.agentName.trim() } : {}),
  };
  if (normalized.transport === 'cloudflare' && !normalized.agentName) {
    throw new Error('Cloudflare transport requires --agent-name (for example pharmacy-agent).');
  }
  return normalized;
}

export async function readHostedConnection(): Promise<HostedConnection | undefined> {
  try {
    const parsed = JSON.parse(await readFile(hostedConfigPath(), 'utf8')) as HostedConnection;
    return validate(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`Invalid Kuralle connection file: ${hostedConfigPath()}`);
    throw error;
  }
}

export async function resolveHostedConnection(argv: string[]): Promise<HostedConnection | undefined> {
  const flags = parseConnectionFlags(argv);
  if (flags.local) return undefined;
  const server = flags.server || process.env.KURALLE_SERVER?.trim();
  if (server) {
    return validate({
      server,
      transport: parseTransport(flags.transport || process.env.KURALLE_TRANSPORT),
      agentName: flags.agentName || process.env.KURALLE_AGENT_NAME,
    });
  }
  return readHostedConnection();
}

export async function saveHostedConnection(connection: HostedConnection): Promise<HostedConnection> {
  const normalized = validate(connection);
  const path = hostedConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

export async function clearHostedConnection(): Promise<boolean> {
  try {
    await rm(hostedConfigPath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function connectionFromArgs(argv: string[]): HostedConnection {
  const cmd = new Command('connect')
    .option('--transport <kind>', 'hosted transport')
    .option('--agent-name <name>', 'hosted agent name')
    .argument('<server>', 'server URL');
  cmd.parse(argv, { from: 'user' });
  const server = cmd.args[0];
  if (!server) throw new Error('Usage: kuralle connect <server> [--transport http|cloudflare] [--agent-name <name>]');
  const opts = cmd.opts<{ transport?: string; agentName?: string }>();
  return validate({
    server,
    transport: parseTransport(opts.transport),
    agentName: opts.agentName,
  });
}
