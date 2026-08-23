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
import { parseJsonTurnResponse, partsFromSseBody } from './frame-parser.js';

const DEFAULT_TIMEOUT_MS = 90_000;

interface HttpTarget {
  url: string;
  agentName?: string;
  auth?: Auth;
}

function pickTimeout(opts?: SendOptions): number {
  if (opts?.abortSignal) return DEFAULT_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

async function* partsToLoggedEvents(
  parts: AsyncIterable<StreamPart>,
  sequencer: EventSequencer,
  sessionId: string,
): AsyncGenerator<LoggedEvent> {
  let sawDone = false;
  for await (const part of parts) {
    yield sequencer.logged(part);
    if (part.type === 'done') sawDone = true;
  }
  if (!sawDone) {
    yield sequencer.logged({ channel: 'client', type: 'done', payload: { sessionId } });
  }
}

export class HttpSession implements Session {
  readonly id: string;
  private readonly attachCursor: AttachCursor;
  private activeAbort: AbortController | null = null;

  constructor(
    private readonly target: HttpTarget,
    sessionId: string,
    cursor?: Cursor,
  ) {
    this.id = sessionId;
    this.attachCursor = new AttachCursor(cursor);
  }

  async send(message: string | UserInputContent, opts?: SendOptions): Promise<TurnResponse> {
    const text = typeof message === 'string' ? message : '';
    return this.runTurn({ message: text, opts });
  }

  async respond(responses: InputResponse[], opts?: SendOptions): Promise<TurnResponse> {
    if (responses.length === 0) {
      throw new Error('respond() requires at least one InputResponse');
    }
    const response = responses[0]!;
    return this.runTurn({
      resume: {
        signalId: randomUUID(),
        requestId: response.requestId,
        name: response.decision !== undefined ? '__approval' : (response.signalName ?? '__signal'),
        decision: response.decision,
        reason: response.reason,
        payload: response.payload,
      },
      opts,
    });
  }

  async cancel(reason?: string): Promise<void> {
    if (this.activeAbort) {
      this.activeAbort.abort(reason);
      this.activeAbort = null;
      return;
    }
    if (!this.target.agentName) {
      throw new Error('cancel() requires an agent name on the HTTP target.');
    }
    const headers = {
      ...authHeaders(this.target.auth),
      'content-type': 'application/json',
    };
    const response = await fetch(
      `${sessionRouteBase(this.target.url, this.target.agentName, this.id)}/cancel`,
      { method: 'POST', headers, body: '{}' },
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
        if (!session.target.agentName) {
          throw new Error('stream() requires an agent name on the HTTP target.');
        }
        const from = opts?.startIndex ?? session.attachCursor.take() ?? 0;
        const follow = opts?.follow ?? false;
        const query = new URLSearchParams({
          from: String(from),
          follow: String(follow),
        });
        const headers = authHeaders(session.target.auth);
        const response = await fetch(
          `${sessionRouteBase(session.target.url, session.target.agentName, session.id)}/events?${query}`,
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
    if (!this.target.agentName) {
      throw new Error('snapshot() requires an agent name on the HTTP target.');
    }
    const headers = authHeaders(this.target.auth);
    const response = await fetch(
      `${sessionRouteBase(this.target.url, this.target.agentName, this.id)}/snapshot?limit=1000`,
      { headers },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Hosted snapshot failed (${response.status}): ${detail.slice(0, 500)}`);
    }
    const body = await response.json() as {
      events: LoggedEvent[];
      cursor: Cursor;
    };
    return body;
  }

  private async *executeTurnEvents(input: {
    message?: string;
    resume?: {
      signalId: string;
      requestId: string;
      name: string;
      decision?: 'approve' | 'deny';
      reason?: string;
      payload?: unknown;
    };
    opts?: SendOptions;
  }): AsyncGenerator<LoggedEvent> {
    const timeoutMs = pickTimeout(input.opts);
    const headers: Record<string, string> = {
      ...authHeaders(this.target.auth),
      'content-type': 'application/json',
    };

    const request = async (path: string, body: unknown, requestHeaders = headers) => fetch(
      `${this.target.url}${path}`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    const sequencer = new EventSequencer();
    let response: Response;

    if (input.resume) {
      response = await request('/api/chat/resume', {
        sessionId: this.id,
        signal: input.resume,
      });
    } else if (this.target.agentName) {
      const path = `/v1/agents/${encodeURIComponent(this.target.agentName)}` +
        `/threads/${encodeURIComponent(this.id)}/messages`;
      response = await request(path, { message: input.message }, {
        ...headers,
        'idempotency-key': input.opts?.idempotencyKey ?? randomUUID(),
      });
    } else {
      response = await request('/api/chat', { sessionId: this.id, message: input.message });
      if (response.status === 404 || response.status === 405) {
        response = await request('/api/chat/sse', { sessionId: this.id, message: input.message });
      }
    }

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
      };
      for (const part of parseJsonTurnResponse(data)) {
        yield sequencer.logged(part);
      }
      yield sequencer.logged({
        channel: 'client',
        type: 'done',
        payload: { sessionId: data.sessionId || this.id },
      });
      return;
    }

    if (!response.body) throw new Error('Hosted chat returned an empty stream.');
    yield* partsToLoggedEvents(partsFromSseBody(response.body), sequencer, this.id);
  }

  private runTurn(input: {
    message?: string;
    resume?: {
      signalId: string;
      requestId: string;
      name: string;
      decision?: 'approve' | 'deny';
      reason?: string;
      payload?: unknown;
    };
    opts?: SendOptions;
  }): TurnResponse {
    const abort = new AbortController();
    this.activeAbort = abort;
    if (input.opts?.abortSignal) {
      input.opts.abortSignal.addEventListener('abort', () => abort.abort(), { once: true });
    }
    return createTurnResponse(this.executeTurnEvents(input), this.id);
  }
}

export function httpTransport(target: Extract<Target, { kind: 'http' }>): Client {
  const httpTarget: HttpTarget = {
    url: target.url,
    agentName: target.agentName,
    auth: target.auth,
  };
  return {
    sessions: {
      create(): Session {
        return new HttpSession(httpTarget, randomUUID());
      },
      attach(sessionId: string, cursor?: Cursor): Session {
        return new HttpSession(httpTarget, sessionId, cursor);
      },
    },
  };
}
