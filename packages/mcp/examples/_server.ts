/// <reference types="bun-types" />

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export { bankingTools } from './banking-tools.js';
export { fashionTools } from './fashion-tools.js';

export interface ExampleTool {
  name: string;
  description: string;
  inputSchema?: z.ZodTypeAny;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface ExampleServerOptions {
  /** 0 asks the OS for an ephemeral port. */
  port: number;
  tools: readonly ExampleTool[];
  /** Pad with generated tools up to this total count. */
  toolCount?: number;
  failOn?: readonly string[];
  record?: boolean;
}

export interface ExampleServerHandle {
  url: string;
  calls(): readonly { tool: string; args: unknown }[];
  close(): Promise<void>;
}

function padTools(base: readonly ExampleTool[], targetCount: number): ExampleTool[] {
  const tools = [...base];
  let index = 0;
  while (tools.length < targetCount) {
    const name = `generated_tool_${index}`;
    tools.push({
      name,
      description:
        `Synthetic auxiliary operation ${index} for disclosure-budget testing. ` +
        'Accepts structured parameters mirroring a real broad MCP catalogue entry.',
      inputSchema: z.object({
        query: z.string().describe('Primary search or filter token for the generated operation'),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Optional maximum number of result rows to return'),
        includeArchived: z
          .boolean()
          .optional()
          .describe('When true, include archived records in the response set'),
      }),
      handler: (args) => ({
        tool: name,
        query: String(args.query ?? ''),
        limit: typeof args.limit === 'number' ? args.limit : 10,
        includeArchived: Boolean(args.includeArchived),
        status: 'ok',
      }),
    });
    index += 1;
  }
  return tools;
}

async function toolNameFromCallRequest(request: Request): Promise<string | undefined> {
  if (request.method !== 'POST') {
    return undefined;
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    return undefined;
  }
  try {
    const body = await request.clone().json();
    if (!body || typeof body !== 'object') {
      return undefined;
    }
    const params = (body as { params?: { name?: unknown } }).params;
    return typeof params?.name === 'string' ? params.name : undefined;
  } catch {
    return undefined;
  }
}

export async function startExampleMcpServer(
  options: ExampleServerOptions,
): Promise<ExampleServerHandle> {
  const recordedCalls: { tool: string; args: unknown }[] = [];
  const failOn = new Set(options.failOn ?? []);
  const tools =
    options.toolCount !== undefined
      ? padTools(options.tools, options.toolCount)
      : [...options.tools];

  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'kuralle-example-mcp', version: '1.0.0' },
      { instructions: 'Shared example MCP server for Kuralle tests and plugins.' },
    );

    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema ?? z.object({}),
        },
        async (args) => {
          if (options.record) {
            recordedCalls.push({ tool: tool.name, args });
          }

          const value = await tool.handler(args as Record<string, unknown>);
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          return {
            content: [{ type: 'text' as const, text }],
          };
        },
      );
    }

    return server;
  });

  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    fetch: async (request) => {
      const toolName = await toolNameFromCallRequest(request);
      if (toolName !== undefined && failOn.has(toolName)) {
        return new Response(`Simulated failure for ${toolName}`, { status: 500 });
      }
      return handler.fetch(request);
    },
  });

  return {
    url: `http://127.0.0.1:${listener.port}/mcp`,
    calls: () => recordedCalls,
    close: async () => {
      void handler.close();
      listener.stop();
    },
  };
}
