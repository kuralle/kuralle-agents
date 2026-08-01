import { serve } from '@hono/node-server';

export interface FetchApplication {
  fetch(request: Request): Response | Promise<Response>;
}

export interface StartDeploymentServerOptions {
  app: FetchApplication;
  port?: number;
  hostname?: string;
  drainTimeoutMs?: number;
  installSignalHandlers?: boolean;
  onListening?: (address: { address: string; port: number }) => void;
}

export interface DeploymentServerHandle {
  readonly port: number;
  readonly activeRequests: number;
  readonly accepting: boolean;
  shutdown(): Promise<void>;
}

function drainedResponse(response: Response, onDrained: () => void): Response {
  let drained = false;
  const finish = () => {
    if (drained) return;
    drained = true;
    onDrained();
  };
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function startDeploymentServer(options: StartDeploymentServerOptions): DeploymentServerHandle {
  const port = options.port ?? 3000;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid deployment server port: ${port}`);
  }
  let accepting = true;
  let activeRequests = 0;
  let shutdownPromise: Promise<void> | undefined;
  let actualPort = port;
  let notifyDrained: (() => void) | undefined;
  const onRequestDrained = () => {
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0) notifyDrained?.();
  };
  const server = serve({
    port,
    hostname: options.hostname,
    fetch: async request => {
      if (!accepting) {
        return Response.json({ error: 'server is draining' }, {
          status: 503,
          headers: { connection: 'close', 'retry-after': '1' },
        });
      }
      activeRequests += 1;
      try {
        return drainedResponse(await options.app.fetch(request), onRequestDrained);
      } catch (error) {
        onRequestDrained();
        throw error;
      }
    },
  }, info => {
    actualPort = info.port;
    options.onListening?.({ address: info.address, port: info.port });
  });
  const connectionServer = server as typeof server & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    accepting = false;
    shutdownPromise = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        connectionServer.closeAllConnections?.();
        reject(new Error(`deployment server did not drain within ${options.drainTimeoutMs ?? 30_000}ms`));
      }, options.drainTimeoutMs ?? 30_000);
      const finish = (error?: Error) => {
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      };
      server.close(error => {
        if (error) return finish(error);
        if (activeRequests === 0) return finish();
        notifyDrained = () => finish();
      });
      connectionServer.closeIdleConnections?.();
    });
    return shutdownPromise;
  };

  if (options.installSignalHandlers ?? true) {
    const handler = () => {
      void shutdown().then(
        () => process.exit(0),
        error => {
          console.error(error);
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  }

  return {
    get port() { return actualPort; },
    get activeRequests() { return activeRequests; },
    get accepting() { return accepting; },
    shutdown,
  };
}
