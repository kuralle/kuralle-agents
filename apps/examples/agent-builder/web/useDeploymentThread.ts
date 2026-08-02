import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useMemo, useRef, useState } from 'react';

export interface ThreadEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Multi-turn chat against a deployed agent — `useChat`, with no bridge.
 *
 * This was a ~130-line hand-rolled SSE reader, because the deployment route
 * emitted named-event frames no AI SDK client understood. The route now serves
 * the same UIMessageStream every Kuralle runtime serves, so what remains is a
 * thin wrapper supplying the two things `useChat` cannot know:
 *
 *   1. the tenant credential, and
 *   2. an `idempotency-key` per logical send, reused on retry so a network
 *      blip cannot duplicate a turn.
 *
 * Conversation history lives on the SERVER, keyed by thread. The client sends
 * one message; the runtime replays the rest.
 */
export function useDeploymentThread(options: {
  agentId: string;
  threadId: string;
  token: string;
}) {
  const { agentId, threadId, token } = options;
  // One key per logical send, held in a ref. `DefaultChatTransport` evaluates
  // `headers` per request, so minting inside that function would produce a
  // fresh key on every retry — turning a network blip into a second turn.
  const idempotencyKey = useRef('');

  /**
   * Transient parts never reach `message.parts`.
   *
   * `data-kuralle-node`, `-flow`, `-control` and `-custom` are written with
   * `transient: true`, so the SDK delivers them to `onData` and drops them from
   * message history. Reading them off `message.parts` yields a panel that
   * renders nothing — which is exactly what this hook did before, and why the
   * events count sat at zero through a working conversation.
   *
   * The persistent ones (`-handoff`, `-interactive`, `-safety`, `-outcome`) DO
   * stay in `message.parts`, so both sources are merged below.
   */
  const [transient, setTransient] = useState<ThreadEvent[]>([]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages`,
        headers: () => ({
          authorization: `Bearer ${token}`,
          'idempotency-key': idempotencyKey.current,
        }),
        // The route takes `{ message }`, not the full useChat message array —
        // history is the server's, so re-sending it would be redundant.
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            message: messages[messages.length - 1]?.parts
              ?.filter(part => part.type === 'text')
              .map(part => (part as { text: string }).text)
              .join('') ?? '',
          },
        }),
      }),
    [agentId, threadId, token],
  );

  const chat = useChat({
    transport,
    id: threadId,
    onData: part => {
      if (!part.type.startsWith('data-')) return;
      setTransient(previous => [
        ...previous,
        { type: part.type, payload: part as unknown as Record<string, unknown> },
      ]);
    },
  });

  const send = useCallback(async (message: string) => {
    // Mint before the send; the transport's header function reads this ref, so
    // a retry of the same send reuses the same key.
    idempotencyKey.current = crypto.randomUUID();
    await chat.sendMessage({ text: message });
  }, [chat]);

  const messages = chat.messages.map(message => ({
    role: message.role as 'user' | 'assistant',
    content: message.parts
      .filter(part => part.type === 'text')
      .map(part => (part as { text: string }).text)
      .join(''),
  }));

  // Persistent Kuralle parts live in history; transient ones arrived via onData.
  const persistent: ThreadEvent[] = chat.messages.flatMap(message =>
    message.parts
      .filter(part => part.type.startsWith('data-'))
      .map(part => ({ type: part.type, payload: part as unknown as Record<string, unknown> })),
  );

  return {
    messages,
    // useChat renders the in-flight assistant message in `messages` directly,
    // so there is no separate "pending" buffer to keep.
    pending: '',
    streaming: chat.status === 'streaming' || chat.status === 'submitted',
    // A 409 means a turn is already running on this thread — not an error, and
    // the key is deliberately NOT cleared so a retry is the same logical send.
    error: chat.error?.message ?? null,
    send,
    reset: () => {
      chat.setMessages([]);
      setTransient([]);
      idempotencyKey.current = '';
    },
    events: [...transient, ...persistent],
  };
}
