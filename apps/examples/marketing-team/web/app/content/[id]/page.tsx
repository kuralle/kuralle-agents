'use client';

import { useParams } from 'next/navigation';
import type { JSONContent } from '@tiptap/react';
import { useCallback, useEffect, useState } from 'react';
import { DocEditor } from '@/components/DocEditor';

interface ContentPiece {
  id: string;
  kind: string;
  title: string;
  slug: string;
  status: string;
  bodyJson: JSONContent;
  metaDescription: string | null;
  targetQuery: string | null;
  authoredByAgent: string | null;
  updatedAt: string;
}

const NEXT_STATUS: Record<string, string | undefined> = {
  draft: 'in-review',
  'in-review': 'approved',
  approved: 'published',
};

export default function ContentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [piece, setPiece] = useState<ContentPiece>();
  const [draft, setDraft] = useState<JSONContent>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/content/${id}`)
      .then((response) => response.json() as Promise<ContentPiece & { error?: string }>)
      .then((body) => {
        if (cancelled) return;
        if (body.error) {
          setError(body.error);
          return;
        }
        setPiece(body);
        setDraft(body.bodyJson);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/content/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: draft }),
      });
      const body = (await response.json()) as { status?: string; changed?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Save failed.');
      setMessage(body.changed ? 'Saved.' : 'No changes to save.');
      setPiece((current) => (current ? { ...current, status: body.status ?? current.status } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [draft, id]);

  const advance = useCallback(async () => {
    if (!piece) return;
    const next = NEXT_STATUS[piece.status];
    if (!next) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/content/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const body = (await response.json()) as { status?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Status change failed.');
      setPiece((current) => (current ? { ...current, status: body.status ?? current.status } : current));
      setMessage(`Moved to ${body.status}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [id, piece]);

  if (error && !piece) {
    return (
      <main className="page">
        <p className="status-message" data-tone="error">
          {error}
        </p>
      </main>
    );
  }

  if (!piece || !draft) {
    return (
      <main className="page">
        <p className="status-message">Loading…</p>
      </main>
    );
  }

  const next = NEXT_STATUS[piece.status];

  return (
    <main className="page">
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18 }}>{piece.title}</h1>
          <p className="status-message">
            {piece.kind} · <span className="badge">{piece.status}</span> · authored by{' '}
            {piece.authoredByAgent ?? 'a person'}
          </p>
          {/*
            Shown here rather than in the editor body. These used to arrive written into the
            markdown itself — first as YAML front matter, then as a trailer — and rendered as
            the first or last thing a reader saw. They have their own columns now, so this is
            where they surface.
          */}
          {piece.metaDescription || piece.targetQuery ? (
            <p className="status-message" style={{ marginTop: 4 }}>
              {piece.metaDescription ? <>Meta: {piece.metaDescription}</> : null}
              {piece.metaDescription && piece.targetQuery ? ' · ' : null}
              {piece.targetQuery ? <>Target query: {piece.targetQuery}</> : null}
            </p>
          ) : null}
        </div>
        <div className="btn-row">
          {next ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void advance()}>
              Move to {next}
            </button>
          ) : null}
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {message ? <p className="status-message">{message}</p> : null}
      {error ? (
        <p className="status-message" data-tone="error">
          {error}
        </p>
      ) : null}

      <DocEditor content={piece.bodyJson} onChange={setDraft} />
    </main>
  );
}
