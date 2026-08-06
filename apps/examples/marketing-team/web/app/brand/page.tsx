'use client';

import type { JSONContent } from '@tiptap/react';
import { useCallback, useEffect, useState } from 'react';
import { DocEditor } from '@/components/DocEditor';

const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

export default function BrandContextPage() {
  const [draft, setDraft] = useState<JSONContent>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/brand-context')
      .then((response) => response.json() as Promise<{ found: boolean; bodyJson?: JSONContent }>)
      .then((body) => {
        if (cancelled) return;
        setDraft(body.found && body.bodyJson ? body.bodyJson : EMPTY_DOC);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/brand-context', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: draft }),
      });
      const body = (await response.json()) as { changed?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Save failed.');
      setMessage(body.changed ? 'Saved.' : 'No changes to save.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [draft]);

  if (!draft) {
    return (
      <main className="page">
        <p className="status-message">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18 }}>Brand context</h1>
          <p className="status-message">The shared positioning document every specialist reads before it works.</p>
        </div>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {message ? <p className="status-message">{message}</p> : null}
      {error ? (
        <p className="status-message" data-tone="error">
          {error}
        </p>
      ) : null}

      <DocEditor content={draft} onChange={setDraft} />
    </main>
  );
}
