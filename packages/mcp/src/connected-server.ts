import type { Client } from '@modelcontextprotocol/client';
import type { Diagnostic } from '@kuralle-agents/plugins';
import { authFailureDiagnostic, authStatusFromError } from './headers.js';
import type { ConnectedMcpServer, McpToolCallOptions } from './types.js';

interface TerminableTransport {
  terminateSession?: () => Promise<void>;
}

function hasTerminateSession(transport: unknown): transport is TerminableTransport {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as TerminableTransport).terminateSession === 'function'
  );
}

function connectionFailureDiagnostic(serverName: string, message: string): Diagnostic {
  return {
    section: '7.2.2',
    rule: 'connection-failure',
    origin: serverName,
    message,
  };
}

/**
 * Detect MCP session termination: HTTP 404.
 *
 * Matched on status, never on `code` or `message`. The SDK labels a 404
 * `CLIENT_HTTP_NOT_IMPLEMENTED`, which is wrong for this status and would key the guard off a name
 * meaning something else; the message text comes from the server and is not a contract.
 */
export function isMcpSessionNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const err = error as { status?: unknown; data?: { status?: unknown } };
  return err.status === 404 || err.data?.status === 404;
}

/**
 * Whether the failed request actually carried a session ID.
 *
 * The spec scopes the re-initialize requirement to a 404 "in response to a request containing an
 * `MCP-Session-Id`". Without this, any 404 from a stateless server — which has no session to expire
 * — would trigger a pointless reconnect and a second doomed attempt. The SDK does not clear
 * `_sessionId` on a failed send (upstream issue #1708), so the stale ID is still readable here.
 */
function hadSession(transport: unknown): boolean {
  if (typeof transport !== 'object' || transport === null) {
    return false;
  }
  const sessionId = (transport as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0;
}

/**
 * The single adapter from an SDK `Client` to a `ConnectedMcpServer`.
 *
 * Every transport goes through here. There used to be a second copy of this on the
 * stdio path, and it drifted: it never checked `isError`, so a failed stdio tool call
 * returned its error text as an ordinary value and recorded a success in the durable
 * journal. One implementation is the fix, not a second patch.
 */
export function createConnectedServer(
  client: Client,
  opts: {
    serverName: string;
    timeoutMs: number;
    configuredHeaders?: Record<string, string>;
    url?: string;
    transport?: unknown;
    onDiagnostic?: (d: Diagnostic) => void;
    reconnect?: () => Promise<{ client: Client; transport?: unknown }>;
  },
): ConnectedMcpServer {
  let currentClient = client;
  let currentTransport = opts.transport;
  let closed = false;

  const closeDeadConnection = async (): Promise<void> => {
    await currentClient.close().catch(() => undefined);
  };

  const recoverFromExpiredSession = async (): Promise<boolean> => {
    if (!opts.reconnect) {
      return false;
    }
    await closeDeadConnection();
    const fresh = await opts.reconnect();
    currentClient = fresh.client;
    currentTransport = fresh.transport;
    return true;
  };

  const withSessionRecovery = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (!isMcpSessionNotFoundError(error) || !hadSession(currentTransport)) {
        throw error;
      }
      const recovered = await recoverFromExpiredSession();
      if (!recovered) {
        throw error;
      }
      return await fn();
    }
  };

  return {
    serverName: opts.serverName,
    configuredHeaders: opts.configuredHeaders ?? {},
    url: opts.url,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;

      const transport = currentTransport;
      if (hasTerminateSession(transport)) {
        try {
          await transport.terminateSession!();
        } catch (error) {
          opts.onDiagnostic?.(
            connectionFailureDiagnostic(
              opts.serverName,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
      await currentClient.close().catch(() => undefined);
    },
    listTools: async () => {
      if (closed) {
        throw new Error(`MCP server "${opts.serverName}" is closed.`);
      }
      return withSessionRecovery(async () => {
        const { tools } = await currentClient.listTools();
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
        }));
      });
    },
    callTool: async (
      name: string,
      args: Record<string, unknown>,
      callOpts?: McpToolCallOptions,
    ) => {
      if (closed) {
        throw new Error(`MCP server "${opts.serverName}" is closed.`);
      }
      return withSessionRecovery(async () => {
        try {
          const result = await currentClient.callTool(
            { name, arguments: args },
            {
              timeout: opts.timeoutMs,
              // Without this the turn's abort rejects our promise while the server keeps
              // running the call. The signal has to reach the request to cancel anything.
              ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
            },
          );
          return extractToolContent(result);
        } catch (error) {
          // `authStatusFromError` returns null for anything that is not an HTTP auth
          // failure, so this is inert on stdio rather than transport-specific.
          const status = authStatusFromError(error);
          if (status === null) {
            throw error;
          }
          throw Object.assign(
            new Error(authFailureDiagnostic(opts.serverName, status).message),
            { status, serverName: opts.serverName },
          );
        }
      });
    },
  };
}

function textOf(
  content: Array<{ type: string; text?: string; [key: string]: unknown }> | undefined,
): string {
  return (content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
}

export function extractToolContent(result: {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}): unknown {
  // `isError: true` is a tool *execution* error — a failed call whose text the model is
  // meant to read and correct against ("date must be in the future"). Returning that text
  // as an ordinary value told the model the call succeeded, and recorded a success in the
  // durable journal, so a replay would skip a call that never worked. Throw instead, and
  // carry the server's message: the spec asks clients to surface these precisely so the
  // model can self-correct rather than repeat the same call.
  if (result.isError) {
    const message = textOf(result.content);
    throw new Error(
      message ? `MCP tool error: ${message}` : 'MCP tool returned an error result',
    );
  }
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
  return null;
}
