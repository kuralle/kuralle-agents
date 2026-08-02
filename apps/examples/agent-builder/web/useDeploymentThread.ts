import { useCallback, useRef, useState } from 'react';

export interface ThreadEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Multi-turn chat over the deployment router's SSE stream.
 *
 * `useChat` from the AI SDK does NOT work against this route, and that is not a
 * bug: `POST /v1/agents/:id/threads/:threadId/messages` emits Kuralle stream
 * parts as NAMED events (`event: text-delta`) whose `data:` is the payload
 * alone — a different wire format from the UIMessageStream `useChat` consumes.
 * The trade is deliberate: tool calls, approvals, and lifecycle events arrive as
 * distinct events the builder can render, at the cost of writing this.
 *
 * Conversation history lives on the SERVER, keyed by the thread id. The client
 * sends one message and the runtime replays the rest, so this hook keeps a
 * local transcript only for display.
 */
export function useDeploymentThread(options: {
  agentId: string;
  threadId: string;
  token: string;
}) {
  const { agentId, threadId, token } = options;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState('');
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per logical send, held across retries. Reusing it is what makes a
  // retry safe; minting a fresh one turns a network blip into a duplicate turn.
  const idempotencyKey = useRef('');

  const reset = useCallback(() => {
    setMessages([]);
    setPending('');
    setEvents([]);
    setError(null);
    idempotencyKey.current = '';
  }, []);

  const send = useCallback(async (message: string) => {
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    setStreaming(true);
    setError(null);
    setPending('');
    setMessages(previous => [...previous, { role: 'user', content: message }]);

    const response = await fetch(
      `/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey.current,
        },
        body: JSON.stringify({ message }),
      },
    );

    if (response.status === 409) {
      // Not an error: a turn is already running on this thread, enforced by a
      // lease. Keep the key — this send has not happened yet.
      setError('This thread already has a turn in flight.');
      setStreaming(false);
      return;
    }
    if (!response.ok || !response.body) {
      setError(`Request failed (${response.status}).`);
      setStreaming(false);
      idempotencyKey.current = '';
      return;
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let answer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      // A stream chunk does not respect SSE frame boundaries, so keep the
      // trailing partial frame for the next read. Skipping this produces
      // intermittent parse failures that never reproduce locally.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const type = frame.match(/^event: (.*)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (!type || !data) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        setEvents(previous => [...previous, { type, payload }]);
        if (type === 'text-delta' && typeof payload.delta === 'string') {
          answer += payload.delta;
          setPending(answer);
        }
        if (type === 'error' && typeof payload.error === 'string') {
          setError(payload.error);
        }
        if (type === 'done') {
          // The turn completed, so the next send is a new logical request.
          idempotencyKey.current = '';
        }
      }
    }

    if (answer) setMessages(previous => [...previous, { role: 'assistant', content: answer }]);
    setPending('');
    setStreaming(false);
  }, [agentId, threadId, token]);

  return { messages, pending, events, streaming, error, send, reset };
}
