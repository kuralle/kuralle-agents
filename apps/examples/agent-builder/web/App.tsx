import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDeploymentThread } from './useDeploymentThread.js';
import { Conversations, Versions } from './Observability.js';
import { Embed } from './Embed.js';

const TENANTS = [
  { token: 'demo-acme', label: 'Acme (tenant: acme)' },
  { token: 'demo-globex', label: 'Globex (tenant: globex)' },
];

interface Form {
  agentId: string;
  name: string;
  description: string;
  instructions: string;
  maxTurns: number;
}

const INITIAL: Form = {
  agentId: 'support',
  name: 'Support Agent',
  description: 'Answers product questions.',
  instructions: 'You are a concise support agent. Answer in one or two sentences.',
  maxTurns: 8,
};

export function App() {
  const [token, setToken] = useState(TENANTS[0]!.token);
  const [form, setForm] = useState<Form>(INITIAL);
  const [revision, setRevision] = useState(0);
  const [version, setVersion] = useState(1);
  const [published, setPublished] = useState<{ versionId: string; digest: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState('');
  // A thread pins its version on the first message and keeps it for life. A
  // stable "preview" id would therefore keep answering as whatever version it
  // first saw — so the id changes whenever the published version does.
  const [nonce, setNonce] = useState(0);
  const [message, setMessage] = useState('What can you help me with?');
  const [refreshKey, setRefreshKey] = useState(0);
  // Tabs, not one long column: each panel is a different job (author, test,
  // operate, ship), and an operator inspecting a trace should not have to
  // scroll past the prompt editor to reach it.
  const [tab, setTab] = useState<'build' | 'preview' | 'observe' | 'embed'>('build');

  const threadId = useMemo(
    () => `preview-${published?.versionId ?? 'draft'}-${nonce}`,
    [published?.versionId, nonce],
  );

  const authed = useCallback((init: RequestInit = {}) => ({
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  }), [token]);

  // Switching tenants is a different agent namespace entirely, so reset — then
  // load whatever that tenant already has. A builder that assumes revision 0 on
  // mount will 409 the first time anyone reloads the page, because the stored
  // draft has moved on without it.
  useEffect(() => {
    let cancelled = false;
    setRevision(0);
    setVersion(1);
    setPublished(null);
    setStatus('');

    void (async () => {
      const draftResponse = await fetch(`/api/agents/${form.agentId}/draft`, authed());
      if (cancelled || !draftResponse.ok) return;
      const { draft } = await draftResponse.json();
      if (draft) {
        setRevision(draft.revision);
        const agent = draft.definition?.agent;
        const instructions = draft.definition?.instructions?.[0]?.content?.text;
        setForm(previous => ({
          ...previous,
          name: agent?.name ?? previous.name,
          description: agent?.description ?? previous.description,
          instructions: instructions ?? previous.instructions,
          maxTurns: agent?.limits?.maxTurns ?? previous.maxTurns,
        }));
        setStatus(`Loaded existing draft at revision ${draft.revision}.`);
      }

      const versionsResponse = await fetch('/api/versions', authed());
      if (cancelled || !versionsResponse.ok) return;
      const { versions } = await versionsResponse.json();
      if (versions.length > 0) {
        setPublished({ versionId: versions[0].versionId, digest: versions[0].digest });
        setVersion(versions[0].version + 1);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const save = useCallback(async () => {
    setConflict(false);
    await fetch(`/api/agents`, authed({ method: 'POST', body: JSON.stringify({ agentId: form.agentId }) }));
    const definition = await (await fetch(
      `/api/agents/${form.agentId}/definition`,
      authed({ method: 'POST', body: JSON.stringify(form) }),
    )).json();

    const response = await fetch(
      `/api/agents/${form.agentId}/draft`,
      authed({ method: 'PUT', body: JSON.stringify({ definition, revision }) }),
    );
    if (response.status === 409) {
      // Two editors is the normal case in a builder. Auto-retrying with the new
      // revision would write this form over the change we just detected.
      setConflict(true);
      return;
    }
    const saved = await response.json();
    setRevision(saved.revision);   // take it from the response, never increment
    setStatus(`Draft saved at revision ${saved.revision}.`);
  }, [authed, form, revision]);

  const publish = useCallback(async () => {
    const response = await fetch(
      `/api/agents/${form.agentId}/publish`,
      authed({ method: 'POST', body: JSON.stringify({ draftRevision: revision, version }) }),
    );
    if (!response.ok) {
      setStatus(`Publish failed: ${(await response.json()).error ?? response.status}`);
      return;
    }
    const result = await response.json();
    setPublished({ versionId: result.versionId, digest: result.digest });
    setVersion(v => v + 1);
    setNonce(n => n + 1);
    setRefreshKey(k => k + 1);
    setStatus(`Published ${result.versionId} and routed traffic to it.`);
  }, [authed, form.agentId, revision, version]);

  const thread = useDeploymentThread({ agentId: form.agentId, threadId, token });

  return (
    <main>
      <header>
        <h1>Kuralle Agent Builder</h1>
        <select value={token} onChange={e => setToken(e.target.value)}>
          {TENANTS.map(t => <option key={t.token} value={t.token}>{t.label}</option>)}
        </select>
      </header>

      <nav className="tabs">
        {([
          ['build', '1 · Build'],
          ['preview', '2 · Preview'],
          ['observe', '3 · Observe'],
          ['embed', '4 · Embed'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'tab on' : 'tab'}
            onClick={() => setTab(id)}
          >{label}</button>
        ))}
      </nav>

      {tab === 'build' && (<><section>
        <h2>1 · Edit the draft</h2>
        <label>Agent id
          <input value={form.agentId} onChange={e => setForm({ ...form, agentId: e.target.value })} />
        </label>
        <label>Name
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>Instructions
          <textarea
            rows={6}
            value={form.instructions}
            onChange={e => setForm({ ...form, instructions: e.target.value })}
          />
        </label>
        <label>Max turns
          <input
            type="number"
            value={form.maxTurns}
            onChange={e => setForm({ ...form, maxTurns: Number(e.target.value) })}
          />
        </label>
        <button onClick={save}>Save draft (revision {revision})</button>
        {conflict && (
          <p className="warn">
            Someone else saved this draft. Reload to see their version — retrying
            would overwrite it.
          </p>
        )}
      </section>

      <section>
        <h2>2 · Publish &amp; release</h2>
        <p>
          Publishing freezes an <strong>immutable</strong> version and points traffic at it.
          Editing later means publishing a new version — v{version} is next.
        </p>
        <button onClick={publish} disabled={revision === 0}>Publish v{version}</button>
        {published && (
          <p className="ok">
            {published.versionId} · digest <code>{published.digest.slice(0, 12)}…</code>
          </p>
        )}
      </section></>)}

      {tab === 'preview' && (<section>
        <h2>Preview</h2>
        <p className="muted">
          thread <code>{threadId}</code> — history lives on the server, so this is a
          real multi-turn conversation, not a sequence of one-shot prompts.
        </p>

        <div className="transcript">
          {thread.messages.map((m, i) => (
            <p key={i} className={m.role === 'user' ? 'msg user' : 'msg assistant'}>
              <strong>{m.role}</strong> {m.content}
            </p>
          ))}
          {thread.messages.length === 0 && (
            <p className="muted">No messages yet.</p>
          )}
        </div>

        <form
          onSubmit={e => {
            e.preventDefault();
            if (!message.trim() || thread.streaming) return;
            const text = message;
            setMessage('');
            void thread.send(text).then(() => setRefreshKey(k => k + 1));
          }}
        >
          <input
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Ask a follow-up…"
          />
          <button type="submit" disabled={thread.streaming || !published}>
            {thread.streaming ? 'Streaming…' : 'Send'}
          </button>
        </form>
        <button onClick={() => { setNonce(n => n + 1); thread.reset(); }}>
          Reset preview thread
        </button>
        {!published && <p className="muted">Publish first — a thread needs a released version.</p>}
        {thread.error && <p className="warn">{thread.error}</p>}
        <details>
          <summary>{thread.events.length} stream events</summary>
          <pre>{thread.events.map(e => e.type).join('\n')}</pre>
        </details>
      </section>)}

      {tab === 'observe' && (<>
        <Conversations authed={authed} refreshKey={refreshKey} />
        <Versions
          authed={authed}
          refreshKey={refreshKey}
          onRollback={() => { setNonce(n => n + 1); thread.reset(); setStatus('Traffic re-pointed.'); }}
        />
      </>)}

      {tab === 'embed' && <Embed token={token} agentId={form.agentId} published={Boolean(published)} />}

      {status && <footer>{status}</footer>}
    </main>
  );
}
