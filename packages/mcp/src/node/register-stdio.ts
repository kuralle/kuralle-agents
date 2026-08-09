import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Diagnostic, McpServerConfig } from '@kuralle-agents/plugins';
import { connectionFailureDiagnostic } from '../connect.js';
import { createConnectedServer } from '../connected-server.js';
import type { ConnectedMcpServer } from '../types.js';
import { authFailureDiagnostic, authStatusFromError } from '../headers.js';
import { registerStdioConnector } from '../mcp-tools.js';

const CLIENT_INFO = { name: 'kuralle-agents', version: '0.20.0' };

async function connectStdioServer(
  config: Extract<McpServerConfig, { type: 'stdio' }>,
  opts: { timeoutMs: number },
): Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
  });
  const client = new Client(CLIENT_INFO);

  try {
    await client.connect(transport, { timeout: opts.timeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    const authStatus = authStatusFromError(error);
    if (authStatus) {
      return { diagnostic: authFailureDiagnostic(config.name, authStatus) };
    }
    const message =
      error instanceof Error ? error.message : 'MCP stdio connection failed.';
    return { diagnostic: connectionFailureDiagnostic(config.name, message) };
  }

  void client.getInstructions();

  // Same adapter as every other transport. stdio used to build its own, and the copy
  // silently dropped `isError` handling.
  return {
    server: createConnectedServer(client, {
      serverName: config.name,
      timeoutMs: opts.timeoutMs,
    }),
  };
}

registerStdioConnector(connectStdioServer);
