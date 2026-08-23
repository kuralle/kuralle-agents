import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Auth, Target } from './types.js';

export type HostedTransport = 'http' | 'cloudflare';

export interface HostedConnection {
  server: string;
  transport?: HostedTransport;
  agentName?: string;
}

export function hostedConfigPath(): string {
  if (process.env.KURALLE_CONFIG?.trim()) return process.env.KURALLE_CONFIG.trim();
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configRoot, 'kuralle', 'connection.json');
}

function normalizeServer(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== 'http:'
    && url.protocol !== 'https:'
    && url.protocol !== 'ws:'
    && url.protocol !== 'wss:'
  ) {
    throw new Error('Hosted server must use http://, https://, ws://, or wss://.');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function inferTransportFromScheme(server: string): HostedTransport {
  const protocol = new URL(server).protocol;
  return protocol === 'ws:' || protocol === 'wss:' ? 'cloudflare' : 'http';
}

function parseTransport(value: string | undefined, server: string): HostedTransport {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return inferTransportFromScheme(server);
  if (normalized !== 'http' && normalized !== 'cloudflare') {
    throw new Error(`Unsupported hosted transport "${value}". Use http or cloudflare.`);
  }
  return normalized;
}

export function inferTargetKind(input: string): 'http' | 'cloudflare' | 'local' {
  try {
    const url = new URL(input);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return 'cloudflare';
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'http';
    return 'local';
  } catch {
    return 'local';
  }
}

function validate(connection: HostedConnection): HostedConnection {
  const server = normalizeServer(connection.server);
  const normalized = {
    server,
    transport: parseTransport(connection.transport, server),
    ...(connection.agentName?.trim() ? { agentName: connection.agentName.trim() } : {}),
  };
  if (normalized.transport === 'cloudflare' && !normalized.agentName) {
    throw new Error('Cloudflare transport requires --agent-name (for example pharmacy-agent).');
  }
  return normalized;
}

export function connectionToTarget(connection: HostedConnection, auth?: Auth): Target {
  const normalized = validate(connection);
  if (normalized.transport === 'cloudflare') {
    return {
      kind: 'cloudflare',
      url: normalized.server,
      agentName: normalized.agentName!,
      auth,
    };
  }
  return {
    kind: 'http',
    url: normalized.server,
    ...(normalized.agentName ? { agentName: normalized.agentName } : {}),
    auth,
  };
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

/**
 * Resolve a target from already-parsed inputs. Each surface parses its own — the CLI with its
 * argument parser, the TUI from a slash command — so this library carries no argv parsing and
 * therefore no dependency on one.
 */
export interface HostedConnectionInput {
  server?: string;
  transport?: string;
  agentName?: string;
  local?: boolean;
}

export async function resolveHostedConnection(
  input: HostedConnectionInput = {},
): Promise<HostedConnection | undefined> {
  if (input.local) return undefined;
  const server = input.server || process.env.KURALLE_SERVER?.trim();
  if (server) {
    return validate({
      server,
      transport: parseTransport(
        input.transport || process.env.KURALLE_TRANSPORT,
        normalizeServer(server),
      ),
      agentName: input.agentName || process.env.KURALLE_AGENT_NAME,
    });
  }
  return readHostedConnection();
}


export async function resolveHostedTarget(
  input: HostedConnectionInput = {},
  auth?: Auth,
): Promise<Target | undefined> {
  const connection = await resolveHostedConnection(input);
  return connection ? connectionToTarget(connection, auth) : undefined;
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

