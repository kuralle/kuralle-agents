'use client';

import { useChat } from '@ai-sdk/react';
import type { KuralleUIMessage } from '@kuralle-agents/core';
import { DefaultChatTransport, type ToolUIPart } from 'ai';
import { useMemo, useState } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Loader } from '@/components/ai-elements/loader';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';

const SUGGESTIONS = [
  'What does our brand context say about positioning?',
  'Draft a LinkedIn post announcing our new pricing page.',
  'Plan a blog post about our Q1 launch.',
] as const;

/**
 * A tool part, which arrives as `tool-<toolName>` rather than `dynamic-tool`.
 *
 * `KuralleUIMessage` leaves the AI SDK's tool generic unset, so the SDK has no static tool map
 * to widen `message.parts` with. The runtime shape is a normal `ToolUIPart` regardless — the
 * stream carries `tool-input-available` / `tool-output-available` without the `dynamic` flag,
 * which is what makes the type `tool-<name>` — so this narrows on the wire shape rather than
 * asking the type system for a guarantee it was never given.
 */
function asToolPart(part: { type: string }): ToolUIPart | null {
  return part.type.startsWith('tool-') ? (part as ToolUIPart) : null;
}

/** `tool-get_brand_context` -> `get_brand_context`, for the collapsed header label. */
function toolLabel(type: string): string {
  return type.replace(/^tool-/, '');
}

export function ChatPanel() {
  const [conversationId] = useState(() => `web_${crypto.randomUUID()}`);
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/chat' }), []);
  const { messages, sendMessage, status, error, clearError } = useChat<KuralleUIMessage>({
    id: conversationId,
    transport,
  });
  const [draft, setDraft] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    clearError();
    setDraft('');
    await sendMessage({ text: trimmed });
  };

  // The turn is working but has not produced anything renderable yet. Without this the panel
  // sits empty for the several seconds the agent spends grounding itself and loading skills.
  const lastMessage = messages[messages.length - 1];
  const awaitingFirstPart =
    busy && (lastMessage?.role !== 'assistant' || lastMessage.parts.length === 0);

  return (
    <div className="chat">
      <Conversation className="chat__messages">
        <ConversationContent>
          {messages.length === 0 ? (
            // `children` REPLACES the default title/description rather than appending to it,
            // so the heading is rendered here alongside the suggestions instead of passed as
            // `title`/`description` props, which would be silently dropped.
            <ConversationEmptyState>
              <div className="space-y-1">
                <h3 className="font-medium text-sm">Ask the marketing lead for anything</h3>
                <p className="text-muted-foreground text-sm">Planning, drafting, or a status check.</p>
              </div>
              <div className="btn-row">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" className="btn" onClick={() => submit(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </ConversationEmptyState>
          ) : (
            messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  {message.parts.map((part, index) => {
                    // Text is markdown. `MessageResponse` streams it through Streamdown, which
                    // renders partial markdown without flashing raw syntax mid-token — the
                    // reason `**bold**` used to appear literally while a chunk was in flight.
                    if (part.type === 'text') {
                      return <MessageResponse key={index}>{part.text}</MessageResponse>;
                    }

                    if (part.type === 'reasoning') {
                      return <MessageResponse key={index}>{part.text}</MessageResponse>;
                    }

                    const toolPart = asToolPart(part);
                    if (toolPart) {
                      return (
                        <Tool key={index}>
                          <ToolHeader
                            type={toolPart.type}
                            title={toolLabel(toolPart.type)}
                            state={toolPart.state}
                          />
                          <ToolContent>
                            <ToolInput input={toolPart.input} />
                            <ToolOutput output={toolPart.output} errorText={toolPart.errorText} />
                          </ToolContent>
                        </Tool>
                      );
                    }

                    return null;
                  })}
                </MessageContent>
              </Message>
            ))
          )}
          {awaitingFirstPart ? <Loader /> : null}
          {error ? (
            <p className="status-message" data-tone="error">
              {error.message}
            </p>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <form
        className="chat__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(draft);
        }}
      >
        <textarea
          aria-label="Message"
          value={draft}
          disabled={busy}
          placeholder="Ask the marketing team…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit(draft);
            }
          }}
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !draft.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
