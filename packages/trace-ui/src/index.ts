import type { AgentSpan, AgentTrace } from '@kuralle-agents/core';

export interface TraceViewerOptions {
  traces?: AgentTrace[];
  sessionId?: string;
  loadTraces?: (sessionId: string) => Promise<AgentTrace[]>;
  nonce?: string;
}

export interface TraceViewer {
  setTraces(traces: AgentTrace[]): void;
  refresh(): Promise<void>;
  destroy(): void;
}

export function mountTraceViewer(target: HTMLElement, options: TraceViewerOptions = {}): TraceViewer {
  const root = target.attachShadow?.({ mode: 'open' }) ?? target;
  const style = document.createElement('style');
  if (options.nonce) style.nonce = options.nonce;
  style.textContent = VIEWER_CSS;
  root.append(style);
  const shell = document.createElement('section');
  shell.className = 'ktrace';
  root.append(shell);
  let traces = options.traces ?? [];

  const render = (): void => renderViewer(shell, traces);
  const refresh = async (): Promise<void> => {
    if (!options.loadTraces || !options.sessionId) return;
    traces = await options.loadTraces(options.sessionId);
    render();
  };
  render();

  return {
    setTraces(next) { traces = next; render(); },
    refresh,
    destroy() { while (root.firstChild) root.firstChild.remove(); },
  };
}

export function renderTraceViewerDocument(traces: AgentTrace[], options: { title?: string; nonce?: string } = {}): string {
  const title = escapeHtml(options.title ?? 'Kuralle Trace Viewer');
  const nonce = options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style${nonce}>${VIEWER_CSS}body{margin:0;background:#0b0d0e;padding:24px}.ktrace{max-width:1440px;margin:auto}</style></head><body>${renderViewerHtml(traces)}</body></html>`;
}

function renderViewer(target: HTMLElement, traces: AgentTrace[]): void {
  target.replaceChildren();
  const template = document.createElement('template');
  template.innerHTML = renderViewerHtml(traces);
  const viewer = template.content.firstElementChild;
  if (viewer) target.append(viewer);
  const rows = target.querySelectorAll<HTMLButtonElement>('[data-span]');
  const detail = target.querySelector<HTMLElement>('[data-detail]');
  for (const row of rows) {
    row.addEventListener('click', () => {
      for (const candidate of rows) candidate.classList.toggle('selected', candidate === row);
      const traceIndex = Number(row.dataset.trace);
      const spanIndex = Number(row.dataset.span);
      if (detail) detail.textContent = JSON.stringify(traces[traceIndex]?.spans[spanIndex] ?? null, null, 2);
    });
  }
}

function renderViewerHtml(traces: AgentTrace[]): string {
  if (traces.length === 0) {
    return '<section class="ktrace"><header><div><span class="eyebrow">KURALLE / OBSERVABILITY</span><h1>No traces captured</h1></div></header><p class="empty">Run an agent turn with tracing enabled, then refresh this view.</p></section>';
  }
  const indexed = traces.flatMap((trace, traceIndex) => trace.spans.map((span, spanIndex) => ({ trace, traceIndex, span, spanIndex })));
  const first = indexed[0]!;
  return `<section class="ktrace"><header><div><span class="eyebrow">KURALLE / OBSERVABILITY</span><h1>Run traces</h1></div><div class="count"><strong>${traces.length}</strong><span>traces</span></div></header><div class="layout"><main><div class="legend"><span>OFFSET</span><span>DURATION</span><span>SPAN / EXECUTION WINDOW</span></div>${traces.map(renderTrace).join('')}</main><aside><div class="detail-title"><span>SPAN DETAIL</span><b>${escapeHtml(first.span.kind)}</b></div><pre data-detail>${escapeHtml(JSON.stringify(first.span, null, 2))}</pre></aside></div></section>`;
}

function renderTrace(trace: AgentTrace, traceIndex: number): string {
  const end = trace.endedAt ?? Math.max(...trace.spans.map((span) => span.endTime ?? span.startTime));
  const duration = Math.max(1, end - trace.startedAt);
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
  return `<article><div class="trace-head"><div><b>${escapeHtml(trace.traceId.slice(0, 12))}</b><span>${escapeHtml(trace.sessionId)}</span></div><time>${formatDuration(end - trace.startedAt)}</time></div><div class="spans">${trace.spans.map((span, spanIndex) => renderSpan(span, traceIndex, spanIndex, trace.startedAt, duration, byId)).join('')}</div></article>`;
}

function renderSpan(span: AgentSpan, traceIndex: number, spanIndex: number, startedAt: number, duration: number, byId: Map<string, AgentSpan>): string {
  const offset = span.startTime - startedAt;
  const elapsed = (span.endTime ?? span.startTime) - span.startTime;
  const left = Math.min(96, Math.max(0, offset / duration * 100));
  const width = Math.max(0.7, Math.min(100 - left, elapsed / duration * 100));
  const depth = spanDepth(span, byId);
  const classes = `${span.status === 'error' ? ' error' : ''}${traceIndex === 0 && spanIndex === 0 ? ' selected' : ''}`;
  return `<button class="span${classes}" data-trace="${traceIndex}" data-span="${spanIndex}" type="button"><code>${offset}ms</code><code>${formatDuration(elapsed)}</code><div class="span-main"><span class="span-name">${'&#160;&#160;'.repeat(depth)}<i>${escapeHtml(marker(span))}</i>${escapeHtml(span.name)}</span><svg class="rail" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="rail-bg" x="0" y="0" width="100" height="8"/><rect class="rail-value" x="${left}" y="0" width="${width}" height="8"/></svg></div></button>`;
}

function spanDepth(span: AgentSpan, byId: Map<string, AgentSpan>): number {
  let depth = 0;
  let parent = span.parentSpanId;
  while (parent && depth < 8) { depth += 1; parent = byId.get(parent)?.parentSpanId; }
  return depth;
}

function marker(span: AgentSpan): string {
  if (span.status === 'error') return '×';
  if (span.kind === 'tool') return '◆';
  if (span.kind === 'handoff') return '→';
  return '●';
}

function formatDuration(ms: number): string { return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`; }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

const VIEWER_CSS = `
:host{display:block;color-scheme:dark}.ktrace{--ink:#e8eadf;--muted:#858b83;--line:#292d2c;--panel:#111415;--acid:#c9ff35;--error:#ff5b4d;color:var(--ink);background:#0b0d0e;border:1px solid #303535;font-family:"IBM Plex Mono","SFMono-Regular",Consolas,monospace;box-shadow:0 24px 80px #0008}.ktrace *{box-sizing:border-box}.ktrace header{height:94px;padding:20px 24px;display:flex;align-items:flex-end;justify-content:space-between;border-bottom:1px solid var(--line);background:linear-gradient(110deg,#141819,#0b0d0e)}.eyebrow{font-size:10px;letter-spacing:.18em;color:var(--acid)}h1{margin:6px 0 0;font:600 28px/1.05 Georgia,serif;letter-spacing:-.03em}.count{display:grid;grid-template-columns:auto auto;gap:0 8px;align-items:end}.count strong{font-size:32px;line-height:.8}.count span{color:var(--muted);font-size:10px;text-transform:uppercase}.layout{display:grid;grid-template-columns:minmax(620px,1.7fr) minmax(300px,.8fr);min-height:560px}.layout main{border-right:1px solid var(--line);overflow:auto}.legend,.span{display:grid;grid-template-columns:72px 82px 1fr}.legend{padding:10px 16px;border-bottom:1px solid var(--line);color:var(--muted);font-size:9px;letter-spacing:.12em}.ktrace article{border-bottom:1px solid var(--line)}.trace-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:#15191a}.trace-head div{display:flex;gap:12px;align-items:baseline}.trace-head b{font-size:12px;color:var(--acid)}.trace-head span,.trace-head time{color:var(--muted);font-size:10px}.span{width:100%;min-height:54px;padding:0 16px;align-items:center;border:0;border-top:1px solid #1d2121;background:transparent;color:inherit;text-align:left;cursor:pointer}.span:hover,.span.selected{background:#1a1f1e}.span.selected{box-shadow:inset 3px 0 var(--acid)}.span code{font-size:10px;color:var(--muted)}.span-main{display:grid;grid-template-columns:minmax(145px,34%) 1fr;align-items:center;gap:16px}.span-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.span-name i{display:inline-block;width:20px;color:var(--acid);font-style:normal}.span.error .span-name i{color:var(--error)}.rail{width:100%;height:8px}.rail-bg{fill:#212625}.rail-value{fill:var(--acid)}.span.error .rail-value{fill:var(--error)}aside{background:var(--panel);min-width:0}.detail-title{height:42px;padding:0 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);font-size:9px;letter-spacing:.12em;color:var(--muted)}.detail-title b{color:var(--acid)}pre{margin:0;padding:18px;max-height:700px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:#bac1b6;font:11px/1.7 "IBM Plex Mono","SFMono-Regular",monospace}.empty{padding:80px 24px;color:var(--muted)}@media(max-width:850px){.layout{grid-template-columns:1fr}.layout main{border-right:0}.layout aside{border-top:1px solid var(--line)}.legend,.span{grid-template-columns:60px 70px minmax(430px,1fr)}}@media(prefers-reduced-motion:no-preference){.span{transition:background .14s ease,box-shadow .14s ease}}
`;
