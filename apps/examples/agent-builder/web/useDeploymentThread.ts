import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useMemo, useRef } from 'react';

/**
 * Multi-turn chat against a deployed agent — now `useChat`, with no bridge.
 *
 * This file used to be a ~110-line hand-rolled SSE reader, because the
 * deployment route emitted named-event frames no AI SDK client understood.
 * The route now serves the same UIMessageStream every other Kuralle runtime
 * serves, so the reader is gone and this is a thin wrapper that supplies two
 * things `useChat` does not know about:
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
  // One key per logical send. Held in a ref so a re-render cannot mint a new
  // one mid-flight, which would turn a retry into a second turn.
  const idempotencyKey = useRef('');

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/v1/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages`,
        headers: () => ({
          authorization: `Bearer ${token}`,
          'idempotency-key': idempotencyKey.current || (idempotencyKey.current = crypto.randomUUID()),
        }),
        // The route takes `{ message }`, not the full useChat message array —
        // history is the server's, so re-sending it would be redundant.
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { message: messages[messages.length - 1]?.parts
            ?.filter(part => part.type === 'text')
            .map(part => (part as { text: string }).text)
            .join('') ?? '' },
        }),
      }),
    [agentId, threadId, token],
  );

  const chat = useChat({ transport, id: threadId });

  const send = useCallback(async (message: string) => {
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    await chat.sendMessage({ text: message });
    // The turn completed, so the next send is a new logical request.
    idempotencyKey.current = '';
  }, [chat]);

  const messages = chat.messages.map(message => ({
    role: message.role as 'user' | 'assistant',
    content: message.parts
      .filter(part => part.type === 'text')
      .map(part => (part as { text: string }).text)
      .join(''),
  }));

  return {
    messages,
    // useChat renders the in-flight assistant message in `messages` directly,
    // so there is no separate "pending" buffer to keep any more.
    pending: '',
    streaming: chat.status === 'streaming' || chat.status === 'submitted',
    error: chat.error?.message ?? null,
    send,
    reset: () => {
      chat.setMessages([]);
      idempotencyKey.current = '';
    },
    // Kuralle's typed data parts arrive here — flow/node/safety/interactive —
    // as real parts rather than something this file has to decode by hand.
    events: chat.messages.flatMap(message =>
      message.parts
        .filter(part => part.type.startsWith('data-'))
        .map(part => ({ type: part.type, payload: part as Record<string, unknown> })),
    ),
  };
}
