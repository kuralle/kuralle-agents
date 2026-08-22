import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Diagnostic, McpServerConfig } from '@kuralle-agents/plugins';
import { activeGeneratedHeaders } from './auth-context.js';
import { createConnectedServer } from './connected-server.js';
import {
  authFailureDiagnostic,
  authStatusFromError,
  headersToFetchInit,
  mergeRequestHeaders,
} from './headers.js';
import { checkAllowedHost, parseRemoteUrl } from './ssrf.js';
import type { ConnectedMcpServer } from './types.js';

const CLIENT_INFO = { name: 'kuralle-agents', version: '0.20.0' };

export function connectionFailureDiagnostic(
  serverName: string,
  message: string,
): Diagnostic {
  return {
    section: '7.2.2',
    rule: 'connection-failure',
    origin: serverName,
    message,
  };
}

export function stdioRequiresNodeDiagnostic(serverName: string): Diagnostic {
  return {
    section: '7.2.2',
    rule: 'unsupported-transport',
    origin: serverName,
    message: `stdio MCP server "${serverName}" cannot run on Cloudflare Workers or workerd (this runtime has no subprocess); on Node or Bun use @kuralle-agents/mcp/node.`,
  };
}

type FetchLike = typeof fetch;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

export function crossOriginHeadersWithheldDiagnostic(
  serverName: string,
  target: string,
): Diagnostic {
  return {
    section: '7.2.1',
    rule: 'cross-origin-headers-withheld',
    origin: serverName,
    message:
      `MCP server "${serverName}" directed a request to "${target}", a different origin than ` +
      'its configured URL. Configured headers and credentials were withheld from that hop. ' +
      'If the endpoint legitimately lives on another origin, configure it as that origin.',
  };
}

function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Header precedence, lowest to highest: plugin-configured, the connect-time credential,
 * then the per-call credential resolved inside the active tool execution.
 *
 * The connect-time layer is what makes `initialize` and `tools/list` authenticated. The
 * per-call layer on top of it lets a rotated token take effect without reconnecting.
 * Agent Plugins §7.2.1 puts client-generated headers above configured ones; both
 * generated layers sit above `configured` here, and the fresher one wins.
 *
 * Redirects are followed manually rather than by the platform. §7.2.1 forbids forwarding
 * configured headers to a different origin, and a platform-followed redirect is invisible
 * to a wrapper — this function is called once and never learns the hop happened. Measured:
 * the platform does strip `Authorization` across origins, but a configured header such as
 * `X-Tenant` is carried through untouched, which is the leak the rule exists to stop.
 */
function createGuardedFetch(
  baseFetch: FetchLike,
  configuredHeaders: Record<string, string> | undefined,
  connectHeaders: Record<string, string>,
  guard: {
    serverName: string;
    configuredOrigin: string;
    allowedHosts: readonly string[] | null;
    onDiagnostic?: (d: Diagnostic) => void;
  },
): FetchLike {
  return async (input, init) => {
    let url = new URL(urlOf(input));
    let method = init?.method ?? 'GET';
    let body = init?.body;

    for (let hop = 0; ; hop += 1) {
      const hostFailure = checkAllowedHost(guard.serverName, url, guard.allowedHosts);
      if (hostFailure) {
        guard.onDiagnostic?.(hostFailure);
        throw new Error(hostFailure.message);
      }

      const headers = new Headers(init?.headers);
      if (url.origin === guard.configuredOrigin) {
        const atConnect = mergeRequestHeaders(configuredHeaders, connectHeaders);
        const merged = mergeRequestHeaders(atConnect, activeGeneratedHeaders());
        for (const [name, value] of Object.entries(merged)) {
          headers.set(name, value);
        }
      } else {
        guard.onDiagnostic?.(
          crossOriginHeadersWithheldDiagnostic(guard.serverName, url.origin),
        );
        headers.delete('authorization');
        for (const name of Object.keys(configuredHeaders ?? {})) {
          headers.delete(name);
        }
      }

      const response = await baseFetch(url, {
        ...init,
        method,
        body,
        headers,
        redirect: 'manual',
      });

      const location = response.headers.get('location');
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return response;
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new Error(
          `MCP server "${guard.serverName}" exceeded ${MAX_REDIRECT_HOPS} redirects.`,
        );
      }

      url = new URL(location, url);
      if (response.status === 303 || (response.status === 302 && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
    }
  };
}

async function openRemoteMcpConnection(
  config: Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }>,
  opts: {
    timeoutMs: number;
    fetch?: FetchLike;
    allowedHosts: readonly string[] | null;
    connectHeaders?: Record<string, string>;
    onDiagnostic?: (d: Diagnostic) => void;
  },
): Promise<
  | {
      client: Client;
      transport: StreamableHTTPClientTransport | SSEClientTransport;
    }
  | { diagnostic: Diagnostic }
> {
  const parsed = parseRemoteUrl(config.url);
  if ('section' in parsed) {
    return { diagnostic: { ...parsed, origin: config.name } };
  }

  const hostFailure = checkAllowedHost(config.name, parsed, opts.allowedHosts);
  if (hostFailure) {
    return { diagnostic: hostFailure };
  }

  const baseFetch = opts.fetch ?? fetch;
  const connectHeaders = opts.connectHeaders ?? {};
  const guardedFetch = createGuardedFetch(baseFetch, config.headers, connectHeaders, {
    serverName: config.name,
    configuredOrigin: parsed.origin,
    allowedHosts: opts.allowedHosts,
    onDiagnostic: opts.onDiagnostic,
  });
  const requestInit = {
    headers: headersToFetchInit(mergeRequestHeaders(config.headers, connectHeaders)),
  };

  const client = new Client(CLIENT_INFO);
  let transport: StreamableHTTPClientTransport | SSEClientTransport;
  if (config.type === 'streamable-http') {
    transport = new StreamableHTTPClientTransport(parsed, {
      fetch: guardedFetch,
      requestInit,
    });
  } else {
    transport = new SSEClientTransport(parsed, {
      fetch: guardedFetch,
      requestInit,
    });
  }

  try {
    await client.connect(transport, { timeout: opts.timeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    const authStatus = authStatusFromError(error);
    if (authStatus) {
      return { diagnostic: authFailureDiagnostic(config.name, authStatus) };
    }
    const message =
      error instanceof Error ? error.message : 'MCP connection failed.';
    return { diagnostic: connectionFailureDiagnostic(config.name, message) };
  }

  // Server instructions are intentionally discarded — never forwarded to prompts.
  void client.getInstructions();

  return { client, transport };
}

export async function connectRemoteMcpServer(
  config: Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }>,
  opts: {
    timeoutMs: number;
    fetch?: FetchLike;
    allowedHosts: readonly string[] | null;
    /** Resolved before the handshake; covers `initialize` and `tools/list`. */
    connectHeaders?: Record<string, string>;
    onDiagnostic?: (d: Diagnostic) => void;
  },
): Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }> {
  const connectOpts = {
    timeoutMs: opts.timeoutMs,
    fetch: opts.fetch,
    allowedHosts: opts.allowedHosts,
    connectHeaders: opts.connectHeaders,
    onDiagnostic: opts.onDiagnostic,
  };

  const opened = await openRemoteMcpConnection(config, connectOpts);
  if ('diagnostic' in opened) {
    return opened;
  }

  const server = createConnectedServer(opened.client, {
    serverName: config.name,
    timeoutMs: opts.timeoutMs,
    configuredHeaders: config.headers ?? {},
    url: config.url,
    transport: opened.transport,
    onDiagnostic: opts.onDiagnostic,
    reconnect: async () => {
      const fresh = await openRemoteMcpConnection(config, connectOpts);
      if ('diagnostic' in fresh) {
        throw new Error(fresh.diagnostic.message);
      }
      return fresh;
    },
  });

  return { server };
}

export async function connectMcpServer(
  config: McpServerConfig,
  opts: {
    timeoutMs: number;
    fetch?: FetchLike;
    allowedHosts: readonly string[] | null;
    connectHeaders?: Record<string, string>;
    onDiagnostic?: (d: Diagnostic) => void;
    fs?: unknown;
    stdio: boolean;
    connectStdio?: (
      config: Extract<McpServerConfig, { type: 'stdio' }>,
      stdioOpts: { timeoutMs: number; fs?: unknown },
    ) => Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }>;
  },
): Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }> {
  if (config.type === 'stdio') {
    if (!opts.stdio || !opts.connectStdio) {
      return { diagnostic: stdioRequiresNodeDiagnostic(config.name) };
    }
    return opts.connectStdio(config, { timeoutMs: opts.timeoutMs, fs: opts.fs });
  }
  return connectRemoteMcpServer(config, opts);
}
