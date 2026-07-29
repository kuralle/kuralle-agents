'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicSupportConfig } from '../src/config';

type Message = { id: string; role: 'user' | 'assistant'; text: string; state?: 'sending' | 'error' };
type PendingApproval = { requestId: string; title: string; description?: string };
type ChatResponse = {
  response?: string;
  text?: string;
  error?: string;
  status?: string;
  pendingApproval?: PendingApproval;
};

function createConversationId(): string {
  return `support_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function SupportChat({ config, apiBaseUrl }: { config: PublicSupportConfig; apiBaseUrl: string }) {
  const [conversationId, setConversationId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingApproval>();
  const endRef = useRef<HTMLDivElement>(null);
  const storageKey = useMemo(() => `kuralle-support:${config.brand.companyName}`, [config.brand.companyName]);

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    const next = stored || createConversationId();
    localStorage.setItem(storageKey, next);
    setConversationId(next);
  }, [storageKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy, pending]);

  async function sendMessage(value: string) {
    const text = value.trim();
    if (!text || !conversationId || busy || pending) return;
    const optimisticId = crypto.randomUUID();
    setDraft('');
    setError('');
    setMessages((current) => [...current, { id: optimisticId, role: 'user', text, state: 'sending' }]);
    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': optimisticId,
        },
        body: JSON.stringify({ conversationId, message: text }),
      });
      const data = await response.json() as ChatResponse;
      if (!response.ok) throw new Error(data.error || `Support request failed (${response.status}).`);
      setMessages((current) => current.map((message) => message.id === optimisticId ? { ...message, state: undefined } : message));
      const reply = (data.response || data.text || '').trim();
      if (reply) setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text: reply }]);
      if (data.pendingApproval) setPending(data.pendingApproval);
      if (!reply && !data.pendingApproval) {
        setMessages((current) => [...current, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: 'I completed the turn but did not receive a displayable response. Please try again.',
        }]);
      }
    } catch (cause) {
      setMessages((current) => current.map((message) => message.id === optimisticId ? { ...message, state: 'error' } : message));
      setError(cause instanceof Error ? cause.message : 'The support service is unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'approve' | 'deny') {
    if (!pending || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/chat/approval`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, requestId: pending.requestId, decision }),
      });
      const data = await response.json() as ChatResponse;
      if (!response.ok) throw new Error(data.error || `Decision failed (${response.status}).`);
      setPending(undefined);
      const reply = (data.response || data.text || (decision === 'deny' ? 'Understood — I did not perform that action.' : '')).trim();
      if (reply) setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text: reply }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The decision could not be delivered.');
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void sendMessage(draft);
  }

  function newConversation() {
    if (busy) return;
    const next = createConversationId();
    localStorage.setItem(storageKey, next);
    setConversationId(next);
    setMessages([]);
    setPending(undefined);
    setError('');
    setDraft('');
  }

  return (
    <main className="support-shell">
      <aside className="context-panel">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">{config.brand.companyName.slice(0, 1)}</span>
          <span>{config.brand.companyName}</span>
        </div>

        <div className="context-copy">
          <p className="kicker">Customer care</p>
          <h1>Answers with a source.<br />Actions with your say.</h1>
          <p>{config.brand.tagline}</p>
        </div>

        <div className="trust-list" aria-label="Support capabilities">
          <div><span className="trust-icon">01</span><p><strong>Policy-grounded</strong>Answers come from your published help content.</p></div>
          <div><span className="trust-icon">02</span><p><strong>Approval before writes</strong>You confirm before a support case is created.</p></div>
          <div><span className="trust-icon">03</span><p><strong>Human when it matters</strong>Security, exceptions, and blocked work are handed over.</p></div>
        </div>

        <div className="availability">
          <span className="status-dot" />
          <div><strong>Human support</strong><span>{config.humanSupport.hours} · {config.humanSupport.timezone}</span></div>
        </div>
      </aside>

      <section className="conversation-panel" aria-label={`${config.brand.companyName} support conversation`}>
        <header className="conversation-header">
          <div className="agent-identity">
            <span className="agent-avatar">{config.brand.agentName.slice(0, 1)}</span>
            <div><h2>{config.brand.agentName}</h2><p><span className="status-dot" /> AI support · human handoff available</p></div>
          </div>
          <button className="quiet-button" type="button" onClick={newConversation} disabled={busy}>New conversation</button>
        </header>

        <div className="message-scroll" aria-live="polite" aria-busy={busy}>
          {messages.length === 0 && (
            <section className="welcome-card">
              <p className="kicker">Start here</p>
              <h2>How can we help?</h2>
              <p>Ask a product question, check an order, troubleshoot an issue, or request a person.</p>
              <div className="starter-grid">
                {config.starterPrompts.map((prompt) => (
                  <button type="button" key={prompt} onClick={() => void sendMessage(prompt)} disabled={!conversationId || busy}>
                    <span>{prompt}</span><span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {messages.map((message) => (
            <article className={`chat-message ${message.role} ${message.state || ''}`} key={message.id}>
              <span className="message-author">{message.role === 'user' ? 'You' : config.brand.agentName}</span>
              <p>{message.text}</p>
              {message.state === 'sending' && <small>Sending…</small>}
              {message.state === 'error' && <small>Not delivered</small>}
            </article>
          ))}

          {pending && (
            <section className="approval-card" role="group" aria-label="Action approval">
              <div className="approval-symbol" aria-hidden="true">✓</div>
              <div className="approval-copy">
                <p className="kicker">Your approval is required</p>
                <h3>{pending.title}</h3>
                {pending.description && <p>{pending.description}</p>}
                <div className="approval-actions">
                  <button type="button" className="approve-button" onClick={() => void decide('approve')} disabled={busy}>Approve action</button>
                  <button type="button" className="deny-button" onClick={() => void decide('deny')} disabled={busy}>No, cancel</button>
                </div>
              </div>
            </section>
          )}

          {busy && !pending && (
            <div className="thinking" aria-label={`${config.brand.agentName} is working`}>
              <span /><span /><span />
            </div>
          )}
          {error && <div className="error-banner" role="alert"><strong>Couldn’t complete that request.</strong><span>{error}</span></div>}
          <div ref={endRef} />
        </div>

        <form className="composer" onSubmit={submit}>
          <label htmlFor="support-message">Message {config.brand.agentName}</label>
          <div className="composer-box">
            <textarea
              id="support-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage(draft);
                }
              }}
              placeholder="Describe what you need help with…"
              rows={2}
              maxLength={16_000}
              disabled={busy || !conversationId || Boolean(pending)}
            />
            <button type="submit" aria-label="Send message" disabled={busy || !conversationId || !draft.trim() || Boolean(pending)}>
              <span>Send</span><span aria-hidden="true">↑</span>
            </button>
          </div>
          <p>Do not share passwords, security codes, API keys, or full payment-card numbers.</p>
        </form>
      </section>
    </main>
  );
}
