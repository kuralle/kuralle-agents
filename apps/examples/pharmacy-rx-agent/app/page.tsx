'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type ChatMessage = { role: 'user' | 'assistant'; text: string };

const starters = [
  'Do you have amoxicillin 500 mg?',
  'Add 10 paracetamol 500 mg tablets to my cart.',
  'What is in my cart?',
  'I have a prescription but the medicine name is unclear. What should I do?',
];

function newSessionId(): string {
  return `web-${crypto.randomUUID()}`;
}

export default function PharmacyChat() {
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem('kuralle-pharmacy-session');
    const id = stored || newSessionId();
    localStorage.setItem('kuralle-pharmacy-session', id);
    setSessionId(id);
  }, []);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || !sessionId || busy) return;
    setInput('');
    setError('');
    setMessages((current) => [...current, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, message }),
      });
      const data = await response.json() as { response?: string; error?: string };
      if (!response.ok) throw new Error(data.error || `Chat failed (${response.status})`);
      setMessages((current) => [...current, {
        role: 'assistant',
        text: data.response?.trim() || 'The agent completed the turn without a text response.',
      }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  function reset() {
    const id = newSessionId();
    localStorage.setItem('kuralle-pharmacy-session', id);
    setSessionId(id);
    setMessages([]);
    setError('');
  }

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand"><span>K</span>Kuralle</div>
        <div className="rail-copy">
          <p className="eyebrow">REFERENCE AGENT</p>
          <h1>Pharmacy operations, grounded in files.</h1>
          <p>One agent definition. Durable Cloudflare state. A hosted Next.js surface. Skills arrive only when the job calls for them.</p>
        </div>
        <dl className="substrates">
          <div><dt>Runtime</dt><dd>Pi + Kuralle</dd></div>
          <div><dt>Conversation</dt><dd>Durable Object</dd></div>
          <div><dt>Workspace</dt><dd>SQLite + mounts</dd></div>
          <div><dt>Skills</dt><dd>Filesystem packages</dd></div>
        </dl>
        <p className="disclaimer">Demonstration only. It does not provide diagnosis or medical advice.</p>
      </aside>

      <section className="chat-panel">
        <header>
          <div>
            <p className="eyebrow">LIVE DURABLE SESSION</p>
            <h2>Pharmacy assistant</h2>
          </div>
          <button className="secondary" onClick={reset}>New session</button>
        </header>

        <div className="messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="welcome">
              <div className="pulse" />
              <h3>Ask about availability, fulfilment, or a prescription.</h3>
              <p>The agent can search read-only pharmacy references, maintain a private durable notes workspace, and load task-specific skills.</p>
              <div className="starters">
                {starters.map((starter) => <button key={starter} onClick={() => void send(starter)}>{starter}</button>)}
              </div>
            </div>
          )}
          {messages.map((message, index) => (
            <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === 'user' ? 'YOU' : 'KURALLE'}</span>
              <p>{message.text}</p>
            </article>
          ))}
          {busy && <article className="message assistant thinking"><span>KURALLE</span><p>Working across tools and workspace…</p></article>}
          {error && <p className="error">{error}</p>}
          <div ref={endRef} />
        </div>

        <form onSubmit={submit} className="composer">
          <label htmlFor="message">Message</label>
          <textarea
            id="message"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask the pharmacy agent…"
            rows={2}
            disabled={busy || !sessionId}
          />
          <button type="submit" disabled={busy || !input.trim() || !sessionId}>Send</button>
          <small>Session {sessionId ? sessionId.slice(0, 20) : 'initialising…'}</small>
        </form>
      </section>
    </main>
  );
}
