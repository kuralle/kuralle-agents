/**
 * Post-call audit: trackVoiceCall POSTs to configurable endpoint (local mock server).
 * Run: bun run packages/kuralle-e2e-tests/tests/postcall-audit/04-analytics-local-endpoint.ts
 */
import { createServer } from 'node:http';
import { createAnalyticsClient } from '@kuralle-agents/analytics-sdk';

const requests: Array<{ method?: string; url?: string; bodySnippet: string }> = [];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: req.method,
      url: req.url,
      bodySnippet: body.length > 240 ? `${body.slice(0, 240)}…` : body,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

await new Promise<void>((resolve) => server.listen(0, resolve));
const addr = server.address();
if (!addr || typeof addr === 'string') {
  throw new Error('Expected TCP listen address');
}
const base = `http://127.0.0.1:${addr.port}/api/v1`;

const client = createAnalyticsClient({
  apiKey: 'local-test-key',
  workspaceId: 'ws-audit',
  endpoint: base,
  enableDebug: false,
});

await client.trackVoiceCall({
  sessionId: 'voice-sess-1',
  workspaceId: 'ws-audit',
  startedAt: new Date(),
  endedAt: new Date(),
  durationSeconds: 42,
});

client.destroy();

await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

console.log(
  JSON.stringify(
    {
      script: '04-analytics-local-endpoint.ts',
      defaultRemoteEndpointIfOmitted: 'https://analytics.kuralle.dev/api/v1',
      localMockBase: base,
      requestsCaptured: requests,
      trackVoiceCallImplemented: true,
      mockMode: 'override endpoint to local HTTP; no built-in no-network mock in SDK',
    },
    null,
    2,
  ),
);
