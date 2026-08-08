/**
 * REQ-13 — the same agent code connects on Node, Bun and workerd.
 *
 * workerd coverage lives in `vitest/runtime-matrix-workers.test.ts` (no listening socket).
 * This example runs the shared check under Node and Bun with a loopback stub server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { mcpTools, type Diagnostic } from '@kuralle-agents/mcp';

async function readRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function incomingToRequest(req: IncomingMessage, baseUrl: string): Promise<Request> {
  const url = new URL(req.url ?? '/', baseUrl);
  const body = await readRequestBody(req);
  return new Request(url.href, {
    method: req.method,
    headers: req.headers as RequestInit['headers'],
    body,
  });
}

async function writeFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

function startLoopbackStubServer(): { url: string; close: () => void } {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'runtime-matrix-stub', version: '1.0.0' });
    server.registerTool(
      'echo',
      {
        description: 'Echo the message field',
        inputSchema: z.object({ message: z.string() }),
      },
      async (args) => ({
        content: [{ type: 'text' as const, text: String(args.message ?? '') }],
      }),
    );
    return server;
  });

  let baseUrl = '';
  let httpServer: Server | undefined;

  httpServer = createServer(async (req, res) => {
    try {
      const request = await incomingToRequest(req, baseUrl);
      const response = await handler.fetch(request);
      await writeFetchResponse(res, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'stub server error';
      res.statusCode = 500;
      res.end(message);
    }
  });

  httpServer.listen(0, '127.0.0.1', () => {
    const address = httpServer!.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind loopback stub server');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  return {
    get url() {
      if (!baseUrl) {
        throw new Error('Stub server not ready');
      }
      return `${baseUrl}/mcp`;
    },
    close: () => {
      void handler.close();
      httpServer?.close();
    },
  };
}

/** Shared runtime matrix check — same logic under Node, Bun, and workerd (via vitest). */
export async function runtimeMatrixCheck(opts: {
  streamableHttpUrl: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const tools = await mcpTools(
    [{ name: 'stub', type: 'streamable-http', url: opts.streamableHttpUrl }],
    opts.fetch ? { fetch: opts.fetch } : undefined,
  );

  if (!Object.keys(tools).includes('stub__echo')) {
    throw new Error(`Expected stub__echo tool, got: ${Object.keys(tools).join(', ') || '(none)'}`);
  }

  const echoed = await tools['stub__echo']!.execute(
    { message: 'hello-runtime-matrix' },
    { session: { id: 's', conversationId: 'c' } } as never,
  );

  if (echoed !== 'hello-runtime-matrix') {
    throw new Error(`Echo tool returned ${JSON.stringify(echoed)}`);
  }

  const diagnostics: Diagnostic[] = [];
  const stdioTools = await mcpTools(
    [{ name: 'local', type: 'stdio', command: 'some-server' }],
    { onDiagnostic: (d) => diagnostics.push(d) },
  );

  if (Object.keys(stdioTools).length !== 0) {
    throw new Error('stdio config must not produce tools on the root export');
  }
  if (diagnostics.length !== 1) {
    throw new Error(`Expected one stdio diagnostic, got ${diagnostics.length}`);
  }

  const [diagnostic] = diagnostics;
  if (diagnostic!.rule !== 'unsupported-transport') {
    throw new Error(`Expected unsupported-transport, got ${diagnostic!.rule}`);
  }

  const message = diagnostic!.message;
  if (!message.includes('stdio')) {
    throw new Error(`Diagnostic must name stdio transport: ${message}`);
  }
  if (!/workers|workerd|cloudflare/i.test(message)) {
    throw new Error(`Diagnostic must name the runtime limit: ${message}`);
  }
  if (!message.includes('@kuralle-agents/mcp/node')) {
    throw new Error(`Diagnostic must name remediation: ${message}`);
  }
}

async function waitForStubReady(stub: { url: string }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      void stub.url;
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Timed out waiting for loopback stub server');
}

async function main(): Promise<void> {
  const stub = startLoopbackStubServer();
  try {
    await waitForStubReady(stub);
    await runtimeMatrixCheck({ streamableHttpUrl: stub.url });
    console.log('runtime matrix: ok');
  } finally {
    stub.close();
  }
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('runtime-matrix.ts') ||
    process.argv[1].endsWith('runtime-matrix.js'));

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`runtime matrix: failed — ${message}`);
    process.exit(1);
  });
}
