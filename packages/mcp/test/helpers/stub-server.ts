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
  /**
   * Opt-in MCP session simulation. The stock handler is stateless and never issues
   * `mcp-session-id`; enable this to exercise client session termination and recovery.
   */
  session?: {
    /** Fixed session id returned on `initialize`; defaults to `stub-session-id`. */
    id?: string;
  };
}

export interface RecordedMcpRequest {
  httpMethod: string;
  jsonRpcMethod: string | null;
  sessionId: string | null;
}

export interface StubMcpServer {
  url: string;
  close: () => void;
  /**
   * Every request the stub saw, recorded whether or not session simulation is on. A stateless
   * server records too — otherwise "no reconnect happened" can only be asserted against a field
   * that is `undefined` in exactly the case being tested, which is an assertion that cannot fail.
   */
  requests: RecordedMcpRequest[];
  /** Present only when `session` was enabled at start. */
  session?: {
    requests: RecordedMcpRequest[];
    /** Invalidate the active session; subsequent requests carrying that id receive 404. */
    expire: () => void;
    /** HTTP status answered to client-initiated `DELETE`; defaults to 200. */
    setDeleteStatus: (status: number) => void;
    /** Every POST carrying a session id receives 404 (bounded-recovery tests). */
    rejectAllSessionPosts: () => void;
    /** `tools/call` and `tools/list` with a session id receive 404; handshake POSTs still succeed. */
    rejectSessionToolPosts: () => void;
  };
}

function jsonRpcMethod(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (
        typeof message === 'object' &&
        message !== null &&
        'method' in message &&
        typeof (message as { method: unknown }).method === 'string'
      ) {
        return (message as { method: string }).method;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isInitializeRequest(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'method' in message &&
        (message as { method: unknown }).method === 'initialize',
    );
  } catch {
    return false;
  }
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

  const sessionEnabled = options.session !== undefined;
  const requests: RecordedMcpRequest[] = [];
  const sessionIdBase = options.session?.id ?? 'stub-session-id';
  let activeSessionId = sessionIdBase;
  let sessionGeneration = 0;
  const expiredSessionIds = new Set<string>();
  let deleteStatus = 200;
  /** When set, every POST carrying a session id receives 404 (bounded-recovery tests). */
  let rejectAllSessionPosts = false;
  /** When set, only tools/call and tools/list with a session id receive 404. */
  let rejectSessionToolPosts = false;

  const record = (request: Request, jsonRpcMethod: string | null) => {
    requests.push({
      httpMethod: request.method,
      jsonRpcMethod,
      sessionId: request.headers.get('mcp-session-id'),
    });
  };

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

      const sessionId = request.headers.get('mcp-session-id');
      const bodyText =
        request.method === 'POST' || request.method === 'DELETE'
          ? await request.text()
          : null;
      const rpcMethod = bodyText ? jsonRpcMethod(bodyText) : null;

      // Recorded unconditionally: a stateless run needs the log too, so a test can assert that no
      // reconnect happened rather than asserting against a field that is absent in that very case.
      record(request, rpcMethod);

      if (sessionEnabled) {
        if (request.method === 'DELETE') {
          return new Response(null, { status: deleteStatus });
        }

        if (
          request.method === 'POST' &&
          sessionId &&
          (expiredSessionIds.has(sessionId) ||
            rejectAllSessionPosts ||
            (rejectSessionToolPosts &&
              rpcMethod !== null &&
              (rpcMethod === 'tools/call' || rpcMethod === 'tools/list')))
        ) {
          return new Response('Session not found', { status: 404 });
        }
      }

      try {
        const forwarded =
          bodyText !== null
            ? new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: bodyText,
              })
            : request;
        const response = await handler.fetch(forwarded);

        if (
          sessionEnabled &&
          request.method === 'POST' &&
          bodyText &&
          isInitializeRequest(bodyText) &&
          response.ok
        ) {
          sessionGeneration += 1;
          activeSessionId =
            sessionGeneration === 1 ? sessionIdBase : `${sessionIdBase}-${sessionGeneration}`;
          const headers = new Headers(response.headers);
          headers.set('mcp-session-id', activeSessionId);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }

        return response;
      } catch {
        // A request can still arrive after the handler shuts down — an aborted call sends
        // `notifications/cancelled`, which races teardown. A real server answers with a
        // status; throwing here becomes an unhandled rejection attributed to whichever
        // test runs next, which is how one abort test failed a later, unrelated one.
        return new Response('MCP stub server is shut down', { status: 503 });
      }
    },
  });

  const stub: StubMcpServer = {
    url: `http://127.0.0.1:${listener.port}/mcp`,
    requests,
    close: () => {
      void handler.close();
      listener.stop();
    },
  };

  if (sessionEnabled) {
    stub.session = {
      requests,
      expire: () => {
        expiredSessionIds.add(activeSessionId);
      },
      setDeleteStatus: (status: number) => {
        deleteStatus = status;
      },
      rejectAllSessionPosts: () => {
        rejectAllSessionPosts = true;
      },
      rejectSessionToolPosts: () => {
        rejectSessionToolPosts = true;
      },
    };
  }

  return stub;
}

export function defaultEchoTool() {
  return {
    name: 'echo',
    description: 'Echo the message field',
    inputSchema: z.object({ message: z.string() }),
    handler: (args: Record<string, unknown>) => String(args.message ?? ''),
  };
}
