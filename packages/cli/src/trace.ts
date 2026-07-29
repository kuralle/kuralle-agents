import type { AgentSpan, AgentTrace } from '@kuralle-agents/core';
import { renderTraceViewerDocument } from '@kuralle-agents/trace-ui';
import { createServer, type Server } from 'node:http';
import type { BuildRuntime } from './agentRuntime.js';
import { fileSessionStore } from './fileStore.js';
import { fileTraceStore } from './fileTraceStore.js';

export async function runTrace(argv: string[], buildRuntime: BuildRuntime): Promise<void> {
  // --store <file> points at the same file `kuralle chat --store` / `kuralle send`
  // persist to; traces live in a sidecar with the extension replaced —
  // `runs/app.json` -> `runs/app.traces.json` (JSONL, one span per line).
  // Without wiring these, buildRuntime falls back to an in-memory store that is
  // always empty in a fresh process, so no persisted trace is ever found.
  const storeIdx = argv.indexOf('--store');
  const storePath = storeIdx >= 0 ? argv[storeIdx + 1] : undefined;
  const sessionId = argv.find((arg, i) => !arg.startsWith('--') && i !== storeIdx + 1);
  if (!sessionId) throw new Error('Usage: kuralle trace <session> [--last] [--json] [--store <file>]');
  const sessionStore = storePath ? fileSessionStore(storePath) : undefined;
  const traceStore = storePath
    ? fileTraceStore(storePath.replace(/\.json$/, '') + '.traces.json')
    : undefined;
  const { runtime } = buildRuntime(sessionId, sessionStore, traceStore);
  if (argv.includes('--web')) {
    const port = numberFlag(argv, '--port') ?? 4319;
    await startTraceWebServer(runtime, sessionId, port);
    process.stdout.write(`Kuralle trace viewer: http://127.0.0.1:${port}\n`);
    return;
  }
  const traces = await runtime.listTraces(sessionId);
  const selected = argv.includes('--last') ? traces.slice(0, 1) : traces;
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(argv.includes('--last') ? selected[0] ?? null : selected, null, 2)}\n`);
    return;
  }
  if (selected.length === 0) {
    process.stdout.write(`No traces found for session ${sessionId}\n`);
    return;
  }
  process.stdout.write(`${selected.map(formatTrace).join('\n\n')}\n`);
}

export async function startTraceWebServer(
  runtime: Pick<import('@kuralle-agents/core').Runtime, 'listTraces' | 'getTrace'>,
  sessionId: string,
  port = 4319,
): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === `/api/traces/${encodeURIComponent(sessionId)}`) {
        return sendJson(response, await runtime.listTraces(sessionId));
      }
      if (url.pathname.startsWith('/api/trace/')) {
        const traceId = decodeURIComponent(url.pathname.slice('/api/trace/'.length));
        const trace = await runtime.getTrace(traceId);
        return sendJson(response, trace, trace ? 200 : 404);
      }
      if (url.pathname === '/') {
        const nonce = crypto.randomUUID().replaceAll('-', '');
        const html = renderTraceViewerDocument(await runtime.listTraces(sessionId), {
          title: `Kuralle traces · ${sessionId}`,
          nonce,
        });
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'self'`,
          'cache-control': 'no-store',
        });
        response.end(html);
        return;
      }
      response.writeHead(404).end('Not found');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

function sendJson(response: import('node:http').ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function numberFlag(argv: string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} requires a valid port`);
  return value;
}

export function formatTrace(trace: AgentTrace): string {
  const start = trace.startedAt;
  const end = trace.endedAt ?? Math.max(...trace.spans.map((span) => span.endTime ?? span.startTime));
  const duration = Math.max(1, end - start);
  const ttft = trace.spans.find((span) => span.kind === 'turn')?.attributes.ttftMs;
  const lines = [
    `trace ${trace.traceId}  session ${trace.sessionId}  ${formatDuration(end - start)}` +
      `${ttft === undefined ? '' : `  TTFT ${formatDuration(ttft)}`}`,
    '  offset    duration  span',
  ];
  for (const span of trace.spans) {
    const offset = span.startTime - start;
    const width = Math.max(1, Math.round(((span.endTime ?? end) - span.startTime) / duration * 30));
    const indent = depth(span, trace.spans) * 2;
    lines.push(
      `${String(offset).padStart(7)}ms  ${formatDuration((span.endTime ?? end) - span.startTime).padStart(8)}  ` +
      `${' '.repeat(indent)}${marker(span)} ${span.name} ${'━'.repeat(width)}`,
    );
  }
  return lines.join('\n');
}

function depth(span: AgentSpan, spans: AgentSpan[]): number {
  const byId = new Map(spans.map((entry) => [entry.spanId, entry]));
  let parent = span.parentSpanId;
  let value = 0;
  while (parent && value < 10) { value += 1; parent = byId.get(parent)?.parentSpanId; }
  return value;
}

function marker(span: AgentSpan): string {
  if (span.status === 'error') return '✕';
  if (span.kind === 'tool') return '🔧';
  if (span.kind === 'handoff') return '⇢';
  return '●';
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}
