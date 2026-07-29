import WebSocket from 'ws';
import type { HostedConnection } from './hostedConnection.js';

export interface HostedTurnEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface HostedTurnResult {
  sessionId: string;
  text: string;
  events: HostedTurnEvent[];
  messageCount?: number;
}

export interface HostedTurnOptions {
  token?: string;
  onText?: (text: string) => void;
  onEvent?: (event: HostedTurnEvent) => void;
  timeoutMs?: number;
}

function textDelta(event: HostedTurnEvent): string {
  if (event.type !== 'text-delta') return '';
  if (typeof event.payload?.delta === 'string') return event.payload.delta;
  const direct = event as HostedTurnEvent & { delta?: unknown };
  return typeof direct.delta === 'string' ? direct.delta : '';
}

function eventFromData(data: string): HostedTurnEvent | undefined {
  try {
    const parsed = JSON.parse(data) as HostedTurnEvent;
    return typeof parsed.type === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function consumeSse(
  source: string,
  state: { buffer: string; text: string; events: HostedTurnEvent[] },
  options: HostedTurnOptions,
): void {
  state.buffer += source.replace(/\r\n/g, '\n');
  let boundary = state.buffer.indexOf('\n\n');
  while (boundary >= 0) {
    const block = state.buffer.slice(0, boundary);
    state.buffer = state.buffer.slice(boundary + 2);
    const data = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data && data !== '[DONE]') {
      const event = eventFromData(data);
      if (event) {
        state.events.push(event);
        options.onEvent?.(event);
        const delta = textDelta(event);
        if (delta) {
          state.text += delta;
          options.onText?.(state.text);
        }
      }
    }
    boundary = state.buffer.indexOf('\n\n');
  }
}

/** Cloudflare's native Agents socket carries one AI SDK data-stream JSON part per
 * response frame. Older adapters may wrap the same parts as SSE, so accept both. */
function consumeCloudflareBody(
  source: string,
  state: { buffer: string; text: string; events: HostedTurnEvent[] },
  options: HostedTurnOptions,
): void {
  const event = eventFromData(source);
  if (!event) {
    consumeSse(source, state, options);
    return;
  }
  state.events.push(event);
  options.onEvent?.(event);
  const delta = textDelta(event);
  if (delta) {
    state.text += delta;
    options.onText?.(state.text);
  }
}

async function httpTurn(
  connection: HostedConnection,
  sessionId: string,
  message: string,
  options: HostedTurnOptions,
): Promise<HostedTurnResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const request = async (path: string) => fetch(`${connection.server}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, message }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let response = await request('/api/chat');
  if (response.status === 404 || response.status === 405) response = await request('/api/chat/sse');
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Hosted chat failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await response.json() as {
      sessionId?: string;
      response?: string;
      error?: string;
      messageCount?: number;
    };
    if (data.error && !data.response) throw new Error(data.error);
    const text = data.response || '';
    if (text) options.onText?.(text);
    return { sessionId: data.sessionId || sessionId, text, events: [], messageCount: data.messageCount };
  }

  if (!response.body) throw new Error('Hosted chat returned an empty stream.');
  const state = { buffer: '', text: '', events: [] as HostedTurnEvent[] };
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    consumeSse(decoder.decode(chunk, { stream: true }), state, options);
  }
  consumeSse(`${decoder.decode()}\n\n`, state, options);
  return { sessionId, text: state.text, events: state.events };
}

function assistantText(messages: unknown): { text: string; count?: number } {
  if (!Array.isArray(messages)) return { text: '' };
  const assistant = [...messages].reverse().find((message) => (
    typeof message === 'object' && message !== null && (message as { role?: unknown }).role === 'assistant'
  )) as { parts?: Array<{ type?: string; text?: string }> } | undefined;
  return {
    text: assistant?.parts?.filter((part) => part.type === 'text').map((part) => part.text || '').join('') || '',
    count: messages.length,
  };
}

async function cloudflareTurn(
  connection: HostedConnection,
  sessionId: string,
  message: string,
  options: HostedTurnOptions,
): Promise<HostedTurnResult> {
  const base = new URL(connection.server);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = `/agents/${encodeURIComponent(connection.agentName!)}/${encodeURIComponent(sessionId)}`;
  if (options.token) base.searchParams.set('token', options.token);

  return new Promise<HostedTurnResult>((resolve, reject) => {
    const ws = new WebSocket(base);
    const requestId = crypto.randomUUID();
    const userMessage = {
      id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: message }],
    };
    const streamed = { buffer: '', text: '', events: [] as HostedTurnEvent[] };
    let persisted: { text: string; count?: number } | undefined;
    let done = false;
    let settled = false;

    const finish = () => {
      if (settled || !done) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      resolve({
        sessionId,
        text: persisted?.text || streamed.text,
        events: streamed.events,
        messageCount: persisted?.count,
      });
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error(`Cloudflare hosted chat timed out after ${options.timeoutMs ?? 90_000}ms.`));
    }, options.timeoutMs ?? 90_000);

    ws.once('open', () => {
      ws.send(JSON.stringify({
        type: 'cf_agent_use_chat_request',
        id: requestId,
        init: {
          method: 'POST',
          body: JSON.stringify({ id: requestId, messages: [userMessage], trigger: 'submit-message' }),
        },
      }));
    });
    ws.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      const type = String(frame.type || '').toLowerCase();
      if (type === 'cf_agent_use_chat_response') {
        if (typeof frame.body === 'string' && frame.body) {
          consumeCloudflareBody(frame.body, streamed, options);
        }
        if (frame.done === true) {
          consumeSse('\n\n', streamed, options);
          done = true;
          setTimeout(finish, 120);
        }
      } else if (type === 'cf_agent_chat_messages') {
        persisted = assistantText(frame.messages);
        if (done) finish();
      }
    });
    ws.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    ws.once('close', () => {
      if (!settled && done) finish();
    });
  });
}

export async function runHostedTurn(
  connection: HostedConnection,
  sessionId: string,
  message: string,
  options: HostedTurnOptions = {},
): Promise<HostedTurnResult> {
  return connection.transport === 'cloudflare'
    ? cloudflareTurn(connection, sessionId, message, options)
    : httpTurn(connection, sessionId, message, options);
}
