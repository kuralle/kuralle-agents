import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { McpServerConfig } from '@kuralle-agents/plugins';
import { connectionFailureDiagnostic } from '../connect.js';
import type { ConnectedMcpServer } from '../types.js';
import { authFailureDiagnostic, authStatusFromError } from '../headers.js';
import { registerStdioConnector } from '../mcp-tools.js';

const CLIENT_INFO = { name: 'kuralle-agents', version: '0.20.0' };
const DEFAULT_TIMEOUT_MS = 60_000;

async function connectStdioServer(
  config: Extract<McpServerConfig, { type: 'stdio' }>,
): Promise<
  | { server: ConnectedMcpServer }
  | { diagnostic: import('@kuralle-agents/plugins').Diagnostic }
> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
  });
  const client = new Client(CLIENT_INFO);

  try {
    await client.connect(transport, { timeout: DEFAULT_TIMEOUT_MS });
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

  return {
    server: {
      serverName: config.name,
      configuredHeaders: {},
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
        const result = await client.callTool(
          { name, arguments: args },
          { timeout: DEFAULT_TIMEOUT_MS },
        );
        if (result.structuredContent !== undefined) {
          return result.structuredContent;
        }
        const text = result.content?.find((block) => block.type === 'text');
        return text && 'text' in text ? text.text : result.content;
      },
    },
  };
}

registerStdioConnector(connectStdioServer);
