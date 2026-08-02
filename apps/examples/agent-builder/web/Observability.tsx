import { useCallback, useEffect, useState } from 'react';

/**
 * The operator surface every production agent platform converges on:
 * a session list, a turn-by-turn transcript, the spans behind it, and version
 * history you can roll back from. A transcript alone cannot tell you why a turn
 * was slow; spans alone cannot tell you what was said.
 */

export interface Conversation {
  threadId: string;
  turns: number;
  messages: number;
  pinnedVersionId: string | null;
  artifactDigest: string | null;
  updatedAt: string | null;
}

interface Span {
  name: string;
  kind: string;
  status: string;
  durationMs: number | null;
  agentVersionId: string | null;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface Trace {
  traceId: string;
  durationMs: number | null;
  usedTool: boolean;
  answer: string;
  spans: Span[];
}

interface Detail {
  threadId: string;
  pin: { agentVersionId: string; artifactDigest: string; releaseId: string } | null;
  messages: Array<{ role: string; content: string }>;
  traces: Trace[];
}

export interface Version {
  versionId: string;
  releaseId: string;
  digest: string;
  version: number;
  publishedAt: string;
  live: boolean;
}

const short = (value: string | null, n = 10) => (value ? `${value.slice(0, n)}…` : '—');
const ms = (value: number | null) => (value === null ? '—' : `${value} ms`);

export function Conversations(props: {
  authed: (init?: RequestInit) => RequestInit;
  refreshKey: number;
}) {
  const { authed, refreshKey } = props;
  const [rows, setRows] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/conversations', authed());
    if (!res.ok) return;
    setRows((await res.json()).conversations);
  }, [authed]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const open = useCallback(async (threadId: string) => {
    setSelected(threadId);
    const res = await fetch(`/api/conversations/${encodeURIComponent(threadId)}`, authed());
    setDetail(res.ok ? await res.json() : null);
  }, [authed]);

  return (
    <section>
      <h2>Conversations</h2>
      <button onClick={() => void load()}>Refresh</button>
      {rows.length === 0 && <p className="muted">No conversations yet — send a message in Preview.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr><th>Thread</th><th>Turns</th><th>Pinned version</th><th>Digest</th><th /></tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.threadId} className={row.threadId === selected ? 'sel' : undefined}>
                <td><code>{row.threadId}</code></td>
                <td>{row.turns}</td>
                <td>{row.pinnedVersionId ?? '—'}</td>
                <td><code>{short(row.artifactDigest)}</code></td>
                <td><button onClick={() => void open(row.threadId)}>Inspect</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && (
        <div className="detail">
          <h3>{detail.threadId}</h3>
          {detail.pin && (
            <p className="muted">
              pinned to <code>{detail.pin.agentVersionId}</code> · release{' '}
              <code>{detail.pin.releaseId}</code> · digest <code>{short(detail.pin.artifactDigest)}</code>
            </p>
          )}

          <h4>Transcript</h4>
          {detail.messages.map((m, i) => (
            <p key={i} className={m.role === 'user' ? 'msg user' : 'msg assistant'}>
              <strong>{m.role}</strong> {m.content}
            </p>
          ))}

          <h4>Traces ({detail.traces.length} turns)</h4>
          {detail.traces.map(trace => (
            <details key={trace.traceId}>
              <summary>
                {short(trace.traceId, 8)} · {ms(trace.durationMs)} · {trace.spans.length} spans
                {trace.usedTool ? ' · used a tool' : ''}
              </summary>
              <table>
                <thead>
                  <tr><th>Span</th><th>Kind</th><th>Status</th><th>Duration</th><th>Model</th><th>Tokens in/out</th></tr>
                </thead>
                <tbody>
                  {trace.spans.map((span, i) => (
                    <tr key={i}>
                      <td>{span.name}</td>
                      <td><code>{span.kind}</code></td>
                      <td className={span.status === 'ok' ? 'ok' : 'warn'}>{span.status}</td>
                      <td>{ms(span.durationMs)}</td>
                      <td>{span.modelId ?? '—'}</td>
                      <td>{span.inputTokens ?? '—'} / {span.outputTokens ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

export function Versions(props: {
  authed: (init?: RequestInit) => RequestInit;
  refreshKey: number;
  onRollback: () => void;
}) {
  const { authed, refreshKey, onRollback } = props;
  const [rows, setRows] = useState<Version[]>([]);

  const load = useCallback(async () => {
    const res = await fetch('/api/versions', authed());
    if (!res.ok) return;
    setRows((await res.json()).versions);
  }, [authed]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const rollback = useCallback(async (releaseId: string) => {
    await fetch('/api/traffic', authed({
      method: 'POST',
      body: JSON.stringify({ releaseId }),
    }));
    await load();
    onRollback();
  }, [authed, load, onRollback]);

  return (
    <section>
      <h2>Versions</h2>
      <p className="muted">
        Versions are immutable and traffic is a pointer, so rollback is one write —
        no rebuild, and open conversations keep the version they pinned.
      </p>
      {rows.length === 0 && <p className="muted">Nothing published yet.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr><th>Version</th><th>Digest</th><th>Published</th><th>Traffic</th><th /></tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.versionId}>
                <td><code>{row.versionId}</code></td>
                <td><code>{short(row.digest)}</code></td>
                <td>{new Date(row.publishedAt).toLocaleTimeString()}</td>
                <td>{row.live ? <span className="ok">live</span> : <span className="muted">—</span>}</td>
                <td>
                  {!row.live && (
                    <button onClick={() => void rollback(row.releaseId)}>Route traffic here</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
