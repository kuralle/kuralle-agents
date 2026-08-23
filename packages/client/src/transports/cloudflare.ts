import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { LoggedEvent, StreamPart, UserInputContent } from '@kuralle-agents/core';
import type {
  Auth,
  Client,
  Cursor,
  InputResponse,
  SendOptions,
  Session,
  Target,
  TurnResponse,
} from '../types.js';
import {
  AttachCursor,
  EventSequencer,
  authHeaders,
  createTurnResponse,
  followNdjsonEvents,
  readNdjsonEventStream,
  sessionRouteBase,
} from './shared.js';
import { consumeCloudflareBody, flushSseBuffer } from './frame-parser.js';

const DEFAULT_TIMEOUT_MS = 90_000;

interface CloudflareTarget {
  url: string;
  agentName: string;
  auth?: Auth;
}

function websocketOrigin(target: CloudflareTarget, sessionId: string): URL {
  const base = new URL(target.url);
  if (base.protocol === 'https:') base.protocol = 'wss:';
  else if (base.protocol === 'http:') base.protocol = 'ws:';
  base.pathname = `/agents/${encodeURIComponent(target.agentName)}/${encodeURIComponent(sessionId)}`;
  if (target.auth?.token) base.searchParams.set('token', target.auth.token);
  return base;
}

function httpOrigin(target: CloudflareTarget): string {
  const base = new URL(target.url);
  if (base.protocol === 'ws:') base.protocol = 'http:';
  else if (base.protocol === 'wss:') base.protocol = 'https:';
  return base.toString().replace(/\/$/, '');
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

export class CloudflareSession implements Session {
  readonly id: string;
  private readonly attachCursor: AttachCursor;

  constructor(
    private readonly target: CloudflareTarget,
    sessionId: string,
    cursor?: Cursor,
  ) {
    this.id = sessionId;
    this.attachCursor = new AttachCursor(cursor);
  }

  async send(message: string | UserInputContent, opts?: SendOptions): Promise<TurnResponse> {
    const text = typeof message === 'string' ? message : '';
    return this.runWebSocketTurn(text, opts);
  }

  async respond(_responses: InputResponse[], _opts?: SendOptions): Promise<TurnResponse> {
    throw new Error('respond() is not supported on the Cloudflare transport yet.');
  }

  async cancel(reason?: string): Promise<void> {
    const headers = {
      ...authHeaders(this.target.auth),
      'content-type': 'application/json',
    };
    const response = await fetch(
      `${sessionRouteBase(httpOrigin(this.target), this.target.agentName, this.id)}/cancel`,
      { method: 'POST', headers, body: JSON.stringify(reason ? { reason } : {}) },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Hosted cancel failed (${response.status}): ${detail.slice(0, 500)}`);
    }
  }

  stream(opts?: {
    startIndex?: number;
    follow?: boolean;
    signal?: AbortSignal;
  }): AsyncIterable<LoggedEvent> {
    const session = this;
    return {
      async *[Symbol.asyncIterator]() {
        const from = opts?.startIndex ?? session.attachCursor.take() ?? 0;
        const follow = opts?.follow ?? false;
        const query = new URLSearchParams({
          from: String(from),
          follow: String(follow),
        });
        const headers = authHeaders(session.target.auth);
        const response = await fetch(
          `${sessionRouteBase(httpOrigin(session.target), session.target.agentName, session.id)}/events?${query}`,
          { headers, signal: opts?.signal },
        );
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`Hosted stream failed (${response.status}): ${detail.slice(0, 500)}`);
        }
        if (follow) {
          yield* followNdjsonEvents(response, opts?.signal);
          return;
        }
        yield* readNdjsonEventStream(response);
      },
    };
  }

  async snapshot(): Promise<{ events: LoggedEvent[]; cursor: Cursor }> {
    const headers = authHeaders(this.target.auth);
    const response = await fetch(
      `${sessionRouteBase(httpOrigin(this.target), this.target.agentName, this.id)}/snapshot?limit=1000`,
      { headers },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Hosted snapshot failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    return response.json() as Promise<{ events: LoggedEvent[]; cursor: Cursor }>;
  }

  private runWebSocketTurn(message: string, opts?: SendOptions): Promise<TurnResponse> {
    const target = this.target;
    const sessionId = this.id;
    const timeoutMs = DEFAULT_TIMEOUT_MS;

    async function* execute(): AsyncGenerator<LoggedEvent> {
      const sequencer = new EventSequencer();
      const base = websocketOrigin(target, sessionId);
      const parts: StreamPart[] = [];
      const sseState = { buffer: '' };
      let persisted: { text: string; count?: number } | undefined;
      let done = false;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(base);
        const requestId = randomUUID();
        const userMessage = {
          id: randomUUID(), role: 'user', parts: [{ type: 'text', text: message }],
        };
        let settled = false;

        const finish = () => {
          if (settled || !done) return;
          settled = true;
          clearTimeout(timeout);
          ws.close();
          resolve();
        };
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.terminate();
          reject(new Error(`Cloudflare hosted chat timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        ws.once('open', () => {
          ws.send(JSON.stringify({
            type: 'cf_agent_use_chat_request',
            id: requestId,
            init: {
              method: 'POST',
              body: JSON.stringify({
                id: requestId,
                messages: [userMessage],
                trigger: 'submit-message',
              }),
            },
          }));
        });
        ws.on('message', (raw) => {
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
          const type = String(frame.type || '').toLowerCase();
          if (type === 'cf_agent_use_chat_response') {
            if (typeof frame.body === 'string' && frame.body) {
              consumeCloudflareBody(frame.body, sseState, (part) => parts.push(part));
            }
            if (frame.done === true) {
              flushSseBuffer(sseState, (part) => parts.push(part));
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

      if (persisted?.text) {
        const id = 'persisted';
        yield sequencer.logged({ channel: 'client', type: 'text-start', payload: { id } });
        yield sequencer.logged({ channel: 'client', type: 'text-delta', payload: { id, delta: persisted.text } });
        yield sequencer.logged({ channel: 'client', type: 'text-end', payload: { id } });
      } else {
        for (const part of parts) {
          yield sequencer.logged(part);
        }
      }
      yield sequencer.logged({ channel: 'client', type: 'done', payload: { sessionId } });
    }

    return Promise.resolve(createTurnResponse(execute(), sessionId));
  }
}

export function cloudflareTransport(target: Extract<Target, { kind: 'cloudflare' }>): Client {
  const cfTarget: CloudflareTarget = {
    url: target.url,
    agentName: target.agentName,
    auth: target.auth,
  };
  return {
    sessions: {
      create(): Session {
        return new CloudflareSession(cfTarget, randomUUID());
      },
      attach(sessionId: string, cursor?: Cursor): Session {
        return new CloudflareSession(cfTarget, sessionId, cursor);
      },
    },
  };
}
