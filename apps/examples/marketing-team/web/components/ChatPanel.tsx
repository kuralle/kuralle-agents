'use client';

import { useChat } from '@ai-sdk/react';
import type { KuralleUIMessage } from '@kuralle-agents/core';
import { DefaultChatTransport } from 'ai';
import { useMemo, useState } from 'react';

const SUGGESTIONS = [
  'What does our brand context say about positioning?',
  'Draft a LinkedIn post announcing our new pricing page.',
  'Plan a blog post about our Q1 launch.',
] as const;

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

  return (
    <div className="chat">
      <div className="chat__messages">
        {messages.length === 0 ? (
          <div className="card">
            <p style={{ marginTop: 0 }}>Ask the marketing lead for anything — planning, drafting, or a status check.</p>
            <div className="btn-row">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" className="btn" onClick={() => submit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="chat__message" data-role={message.role}>
              {message.parts.map((part, index) => (part.type === 'text' ? <span key={index}>{part.text}</span> : null))}
            </div>
          ))
        )}
        {error ? (
          <p className="status-message" data-tone="error">
            {error.message}
          </p>
        ) : null}
      </div>
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
