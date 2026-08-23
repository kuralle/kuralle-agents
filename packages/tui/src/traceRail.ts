import type { TurnView } from '@kuralle-agents/client';

export type TraceSpanKind = 'turn' | 'flow' | 'node' | 'tool' | 'handoff';

export interface TraceSpanLine {
  id: string;
  name: string;
  kind: TraceSpanKind;
  depth: number;
  ms: number | null;
  error: boolean;
}

export function traceSpansFromView(view: TurnView): TraceSpanLine[] {
  const lines: TraceSpanLine[] = [{
    id: 'turn',
    name: 'turn',
    kind: 'turn',
    depth: 0,
    ms: view.timings.totalMs,
    error: view.status === 'failed',
  }];

  let depth = 0;
  for (const block of view.blocks) {
    if (block.kind === 'flow') {
      if (block.phase === 'enter') {
        depth += 1;
        lines.push({
          id: block.id,
          name: block.node ? `node:${block.node}` : `flow:${block.flow}`,
          kind: block.node ? 'node' : 'flow',
          depth,
          ms: null,
          error: false,
        });
      } else if (block.phase === 'end') {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (block.kind === 'tool') {
      lines.push({
        id: block.id,
        name: `tool:${block.name}`,
        kind: 'tool',
        depth: depth + 1,
        ms: block.ms ?? null,
        error: block.state === 'error',
      });
      continue;
    }
    if (block.kind === 'handoff') {
      lines.push({
        id: block.id,
        name: `handoff:${block.to}`,
        kind: 'handoff',
        depth: depth + 1,
        ms: null,
        error: false,
      });
    }
  }
  return lines;
}

export function traceTokenLine(view: TurnView): string | null {
  const parts: string[] = [];
  const tin = view.usage.inputTokens;
  const tout = view.usage.outputTokens;
  const ctx = view.usage.contextTokens;
  const ttft = view.timings.ttftMs;
  if (tin !== undefined || tout !== undefined) {
    parts.push(`turn ${tin ?? '?'}↓/${tout ?? '?'}↑ tok`);
  }
  if (ctx !== undefined) parts.push(`ctx ${ctx} tok`);
  if (ttft !== null) parts.push(`TTFT ${ttft}ms`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function spanKindColor(kind: TraceSpanKind): string {
  switch (kind) {
    case 'turn':
      return '#c0caf5';
    case 'flow':
      return '#bb9af7';
    case 'node':
      return '#7aa2f7';
    case 'tool':
      return '#e0af68';
    case 'handoff':
      return '#7dcfff';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
