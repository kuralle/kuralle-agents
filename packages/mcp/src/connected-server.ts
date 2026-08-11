import type { Client } from '@modelcontextprotocol/client';
import { authFailureDiagnostic, authStatusFromError } from './headers.js';
import type { ConnectedMcpServer, McpToolCallOptions } from './types.js';

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
  },
): ConnectedMcpServer {
  return {
    serverName: opts.serverName,
    configuredHeaders: opts.configuredHeaders ?? {},
    url: opts.url,
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
    callTool: async (
      name: string,
      args: Record<string, unknown>,
      callOpts?: McpToolCallOptions,
    ) => {
      try {
        const result = await client.callTool(
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
