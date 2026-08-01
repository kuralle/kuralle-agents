import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { startDeploymentServer } from '../src/node.js';

describe('startDeploymentServer', () => {
  it('serves a Hono app and shuts down cleanly with admission disabled', async () => {
    const app = new Hono();
    app.get('/health/ready', c => c.json({ status: 'ready' }));
    let listening!: (port: number) => void;
    const ready = new Promise<number>(resolve => { listening = resolve; });
    const server = startDeploymentServer({
      app,
      port: 0,
      installSignalHandlers: false,
      onListening: info => listening(info.port),
    });
    const port = await ready;

    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
    expect(server.port).toBe(port);
    await server.shutdown();
    expect(server.accepting).toBe(false);
    expect(server.activeRequests).toBe(0);
  });
});
