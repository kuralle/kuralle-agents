import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface StubMcpServerOptions {
  instructions?: string;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema?: z.ZodTypeAny;
    /** Declaring this makes the server return `structuredContent` validated against it. */
    outputSchema?: z.ZodTypeAny;
    handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  }>;
  intercept?: (request: Request) => Response | undefined;
}

export interface StubMcpServer {
  url: string;
  close: () => void;
}

export function startStubMcpServer(options: StubMcpServerOptions = {}): StubMcpServer {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'stub-mcp', version: '1.0.0' },
      { instructions: options.instructions },
    );

    for (const tool of options.tools ?? []) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema ?? z.object({}),
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        },
        async (args) => {
          const value = await tool.handler(args as Record<string, unknown>);
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          if (tool.outputSchema) {
            return {
              content: [{ type: 'text', text }],
              structuredContent: value as Record<string, unknown>,
            };
          }
          return {
            content: [{ type: 'text', text }],
          };
        },
      );
    }

    return server;
  });

  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      if (options.intercept) {
        const intercepted = options.intercept(request);
        if (intercepted) {
          return intercepted;
        }
      }
      try {
        return await handler.fetch(request);
      } catch {
        // A request can still arrive after the handler shuts down — an aborted call sends
        // `notifications/cancelled`, which races teardown. A real server answers with a
        // status; throwing here becomes an unhandled rejection attributed to whichever
        // test runs next, which is how one abort test failed a later, unrelated one.
        return new Response('MCP stub server is shut down', { status: 503 });
      }
    },
  });

  return {
    url: `http://127.0.0.1:${listener.port}/mcp`,
    close: () => {
      void handler.close();
      listener.stop();
    },
  };
}

export function defaultEchoTool() {
  return {
    name: 'echo',
    description: 'Echo the message field',
    inputSchema: z.object({ message: z.string() }),
    handler: (args: Record<string, unknown>) => String(args.message ?? ''),
  };
}
