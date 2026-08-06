'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface ContentRow {
  id: string;
  kind: string;
  title: string;
  slug: string;
  status: string;
  authoredByAgent: string | null;
  updatedAt: string;
}

const KINDS = ['blog', 'landing', 'case-study', 'newsletter', 'docs', 'social', 'email'] as const;
const STATUSES = ['draft', 'in-review', 'approved', 'published'] as const;

export default function ContentLibraryPage() {
  const [rows, setRows] = useState<ContentRow[]>();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (status) params.set('status', status);
    const response = await fetch(`/api/content?${params.toString()}`);
    const body = (await response.json()) as { content?: ContentRow[]; error?: string };
    if (!response.ok) {
      setError(body.error ?? 'Could not load content.');
      return;
    }
    setError(undefined);
    setRows(body.content ?? []);
  }, [kind, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="page">
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Content library</h1>
        <div className="filters">
          <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Filter by kind">
            <option value="">All kinds</option>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p className="status-message" data-tone="error">
          {error}
        </p>
      ) : null}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Authored by</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/content/${row.id}`}>{row.title}</Link>
                </td>
                <td>{row.kind}</td>
                <td>
                  <span className="badge">{row.status}</span>
                </td>
                <td>{row.authoredByAgent ?? '—'}</td>
                <td>{new Date(row.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && rows.length === 0 ? <p className="status-message">Nothing here yet.</p> : null}
      </div>
    </main>
  );
}
