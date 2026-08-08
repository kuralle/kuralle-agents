import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Diagnostic, McpServerConfig } from '@kuralle-agents/plugins';
import type { Session } from '@kuralle-agents/core';
import { activeGeneratedHeaders } from './auth-context.js';
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

function createGuardedFetch(
  baseFetch: FetchLike,
  configuredHeaders: Record<string, string> | undefined,
): FetchLike {
  return async (input, init) => {
    const generated = activeGeneratedHeaders();
    const merged = mergeRequestHeaders(configuredHeaders, generated);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(merged)) {
      headers.set(name, value);
    }
    return baseFetch(input, { ...init, headers });
  };
}

function extractToolContent(result: {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (result.content && result.content.length > 0) {
    const texts = result.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string);
    if (texts.length === 1) {
      return texts[0];
    }
    if (texts.length > 1) {
      return texts.join('\n');
    }
    return result.content;
  }
  if (result.isError) {
    throw new Error('MCP tool returned an error result');
  }
  return null;
}

export async function connectRemoteMcpServer(
  config: Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }>,
  opts: {
    timeoutMs: number;
    fetch?: FetchLike;
    allowedHosts: readonly string[] | null;
    session: Session;
  },
): Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }> {
  const parsed = parseRemoteUrl(config.url);
  if ('section' in parsed) {
    return { diagnostic: { ...parsed, origin: config.name } };
  }

  const hostFailure = checkAllowedHost(config.name, parsed, opts.allowedHosts);
  if (hostFailure) {
    return { diagnostic: hostFailure };
  }

  const baseFetch = opts.fetch ?? fetch;
  const guardedFetch = createGuardedFetch(baseFetch, config.headers);
  const requestInit = {
    headers: headersToFetchInit(config.headers ?? {}),
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

  const server: ConnectedMcpServer = {
    serverName: config.name,
    configuredHeaders: config.headers ?? {},
    url: config.url,
    close: async () => {
      await client.close();
    },
    listTools: async () => {
      const { tools } = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      }));
    },
    callTool: async (name, args) => {
      try {
        const result = await client.callTool(
          { name, arguments: args },
          { timeout: opts.timeoutMs },
        );
        return extractToolContent(result);
      } catch (error) {
        const authStatus = authStatusFromError(error);
        if (authStatus) {
          throw Object.assign(
            new Error(authFailureDiagnostic(config.name, authStatus).message),
            {
              mcpAuthFailure: true,
              status: authStatus,
              serverName: config.name,
            },
          );
        }
        throw error;
      }
    },
  };

  return { server };
}

export async function connectMcpServer(
  config: McpServerConfig,
  opts: {
    timeoutMs: number;
    fetch?: FetchLike;
    allowedHosts: readonly string[] | null;
    session: Session;
    stdio: boolean;
    connectStdio?: (
      config: Extract<McpServerConfig, { type: 'stdio' }>,
    ) => Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }>;
  },
): Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }> {
  if (config.type === 'stdio') {
    if (!opts.stdio || !opts.connectStdio) {
      return { diagnostic: stdioRequiresNodeDiagnostic(config.name) };
    }
    return opts.connectStdio(config);
  }
  return connectRemoteMcpServer(config, opts);
}
