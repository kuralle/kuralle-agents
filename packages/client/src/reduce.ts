import type {
  ContextCompactedPayload,
  HitlInterrupt,
  LoggedEvent,
  StreamPart,
} from '@kuralle-agents/core';

export type { LoggedEvent };

export type TurnStatus =
  | 'idle'
  | 'streaming'
  | 'completed'
  | 'waiting'
  | 'input-required'
  | 'escalated'
  | 'failed';

export interface TurnView {
  blocks: Block[];
  status: TurnStatus;
  pending: HitlInterrupt[];
  timings: { ttftMs: number | null; totalMs: number | null };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  memory: {
    extracted: Array<{ slug: string; value: unknown; at: number }>;
    compactions: ContextCompactedPayload[];
  };
  /** Highest LoggedEvent.index folded so far; -1 on an empty view. */
  cursor: number;
  startedAt: number | null;
}

export type Block =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | {
      id: string;
      kind: 'tool';
      name: string;
      args: unknown;
      result?: unknown;
      state: 'running' | 'ok' | 'error';
      ms?: number;
      startedAt?: number;
    }
  | { id: string; kind: 'flow'; flow: string; node?: string; phase: 'enter' | 'transition' | 'end' }
  | { id: string; kind: 'handoff'; to: string; reason?: string }
  | { id: string; kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

function emptyView(): TurnView {
  return {
    blocks: [],
    status: 'idle',
    pending: [],
    timings: { ttftMs: null, totalMs: null },
    usage: {},
    memory: { extracted: [], compactions: [] },
    cursor: -1,
    startedAt: null,
  };
}

function cloneView(view: TurnView): TurnView {
  return {
    blocks: view.blocks.map((block) => ({ ...block })),
    status: view.status,
    pending: [...view.pending],
    timings: { ...view.timings },
    usage: { ...view.usage },
    memory: {
      extracted: view.memory.extracted.map((entry) => ({ ...entry })),
      compactions: [...view.memory.compactions],
    },
    cursor: view.cursor ?? -1,
    startedAt: view.startedAt ?? null,
  };
}

// ponytail: O(blocks) per lookup; add an index on the view if transcripts get long enough to matter
function findAssistantBlockIndex(view: TurnView, id: string): number | undefined {
  const index = view.blocks.findIndex((b) => b.kind === 'assistant' && b.id === id);
  return index === -1 ? undefined : index;
}

function findToolBlockIndex(view: TurnView, toolCallId: string): number | undefined {
  const index = view.blocks.findIndex((b) => b.kind === 'tool' && b.id === toolCallId);
  return index === -1 ? undefined : index;
}

function currentFlowFromBlocks(view: TurnView): string | null {
  let current: string | null = null;
  for (const block of view.blocks) {
    if (block.kind === 'flow') {
      if (block.phase === 'enter') current = block.flow;
      if (block.phase === 'end') current = null;
    }
  }
  return current;
}

function markStreaming(view: TurnView): void {
  if (view.status === 'idle') view.status = 'streaming';
}

function pushNotice(
  view: TurnView,
  id: string,
  level: 'info' | 'warn' | 'error',
  text: string,
): void {
  view.blocks.push({ id, kind: 'notice', level, text });
}

function openAssistantBlock(view: TurnView, id: string): void {
  markStreaming(view);
  if (findAssistantBlockIndex(view, id) !== undefined) return;
  view.blocks.push({ id, kind: 'assistant', text: '', streaming: true });
}

function appendAssistantDelta(
  view: TurnView,
  id: string,
  delta: string,
  at: number,
): void {
  markStreaming(view);
  let index = findAssistantBlockIndex(view, id);
  if (index === undefined) {
    openAssistantBlock(view, id);
    index = findAssistantBlockIndex(view, id)!;
  }
  const block = view.blocks[index];
  if (block?.kind !== 'assistant') return;
  if (delta && view.startedAt !== null && view.timings.ttftMs === null) {
    view.timings.ttftMs = at - view.startedAt;
  }
  block.text += delta;
}

function closeAssistantBlock(
  view: TurnView,
  id: string,
  cancelled?: string,
): void {
  const index = findAssistantBlockIndex(view, id);
  if (index === undefined) return;
  const block = view.blocks[index];
  if (block?.kind !== 'assistant') return;
  block.streaming = false;
  if (cancelled) {
    pushNotice(view, `text-cancel:${id}`, 'warn', cancelled);
  }
}

function pushToolCall(
  view: TurnView,
  event: LoggedEvent,
  payload: Extract<StreamPart, { type: 'tool-call' }>['payload'],
): void {
  markStreaming(view);
  const toolCallId = payload.toolCallId ?? `tool:${event.index}`;
  view.blocks.push({
    id: toolCallId,
    kind: 'tool',
    name: payload.toolName,
    args: payload.args,
    state: 'running',
    startedAt: event.at,
  });
}

function resolveToolResult(
  view: TurnView,
  event: LoggedEvent,
  payload: Extract<StreamPart, { type: 'tool-result' }>['payload'],
): void {
  const toolCallId = payload.toolCallId ?? view.blocks.find((block) => {
    return block.kind === 'tool' && block.name === payload.toolName && block.state === 'running';
  })?.id;
  if (!toolCallId) return;
  const index = findToolBlockIndex(view, toolCallId);
  if (index === undefined) return;
  const block = view.blocks[index];
  if (block?.kind !== 'tool') return;
  block.result = payload.result;
  if (block.startedAt !== undefined) block.ms = event.at - block.startedAt;
  if (payload.preliminary) {
    block.state = 'running';
    return;
  }
  const failed =
    payload.result !== null
    && typeof payload.result === 'object'
    && 'error' in (payload.result as Record<string, unknown>)
    && (payload.result as { error?: unknown }).error !== undefined;
  block.state = failed ? 'error' : 'ok';
}

function pushFlowBlock(
  view: TurnView,
  id: string,
  flow: string,
  phase: 'enter' | 'transition' | 'end',
  node?: string,
): void {
  markStreaming(view);
  view.blocks.push({ id, kind: 'flow', flow, node, phase });
}

function foldEvent(view: TurnView, event: LoggedEvent): void {
  if (view.startedAt === null) view.startedAt = event.at;
  const { part } = event;
  const id = `${event.index}:${part.type}`;

  switch (part.type) {
    case 'text-start':
      openAssistantBlock(view, part.payload.id);
      break;
    case 'text-delta':
      appendAssistantDelta(view, part.payload.id, part.payload.delta, event.at);
      break;
    case 'text-end':
      closeAssistantBlock(view, part.payload.id);
      break;
    case 'text-cancel':
      closeAssistantBlock(view, part.payload.id, part.payload.reason);
      break;
    case 'tool-batch-start':
      break;
    case 'tool-call':
      pushToolCall(view, event, part.payload);
      break;
    case 'tool-result':
      resolveToolResult(view, event, part.payload);
      break;
    case 'model-call-start':
    case 'model-call-end':
      break;
    case 'flow-enter':
      pushFlowBlock(view, id, part.payload.flow, 'enter');
      break;
    case 'flow-end':
      pushFlowBlock(view, id, part.payload.flow, 'end');
      break;
    case 'flow-transition':
      pushFlowBlock(
        view,
        id,
        part.payload.to,
        'transition',
        part.payload.from,
      );
      break;
    case 'node-enter':
      pushFlowBlock(
        view,
        id,
        currentFlowFromBlocks(view) ?? part.payload.nodeName,
        'enter',
        part.payload.nodeName,
      );
      break;
    case 'node-exit':
      pushFlowBlock(
        view,
        id,
        currentFlowFromBlocks(view) ?? part.payload.nodeName,
        'end',
        part.payload.nodeName,
      );
      break;
    case 'handoff':
      markStreaming(view);
      view.blocks.push({
        id,
        kind: 'handoff',
        to: part.payload.targetAgent,
        reason: part.payload.reason,
      });
      break;
    case 'interrupted':
      pushNotice(view, id, 'warn', part.payload.reason);
      view.status = 'waiting';
      break;
    case 'paused':
      view.status = 'input-required';
      view.pending.push(part.payload.interrupt);
      break;
    case 'conversation-outcome':
      pushNotice(view, id, 'info', String(part.payload.outcome));
      break;
    case 'interactive':
      view.status = 'input-required';
      pushNotice(view, id, 'info', part.payload.prompt);
      break;
    case 'turn-end':
      if (view.status === 'streaming' || view.status === 'idle') view.status = 'waiting';
      break;
    case 'turn-incomplete':
      pushNotice(view, id, 'warn', part.payload.reason);
      view.status = 'failed';
      break;
    case 'extraction':
      view.memory.extracted.push({
        slug: part.payload.slug,
        value: part.payload.value,
        at: event.at,
      });
      break;
    case 'pipeline-validation-block':
      pushNotice(
        view,
        id,
        'warn',
        part.payload.userFacingMessage ?? part.payload.rationale,
      );
      break;
    case 'safety-blocked':
      pushNotice(view, id, 'error', part.payload.userFacingMessage);
      view.status = 'failed';
      break;
    case 'wake':
      pushNotice(view, id, 'info', part.payload.reason);
      break;
    case 'escalation':
      view.status = 'escalated';
      pushNotice(
        view,
        id,
        part.payload.outcome === 'failed' ? 'error' : 'info',
        part.payload.summary ?? part.payload.reason,
      );
      break;
    case 'context-compacted':
      view.memory.compactions.push(part.payload);
      break;
    case 'compaction-skipped':
      pushNotice(view, id, 'info', part.payload.reason);
      break;
    case 'context-overflow-recovered':
      pushNotice(
        view,
        id,
        'info',
        `Recovered overflow (stripped ${part.payload.strippedCount}, compacted=${part.payload.compacted})`,
      );
      break;
    case 'error':
      pushNotice(view, id, 'error', part.payload.error);
      view.status = 'failed';
      break;
    case 'custom':
      pushNotice(view, id, 'info', part.payload.name);
      break;
    case 'done':
      view.status = 'completed';
      if (view.startedAt !== null) {
        view.timings.totalMs = event.at - view.startedAt;
      }
      if (part.payload.usage) {
        view.usage = { ...view.usage, ...part.payload.usage };
      }
      break;
    case 'knowledge-cache-hit':
      pushNotice(
        view,
        id,
        'info',
        `cache hit (${part.payload.resultCount} results, ${part.payload.latencyMs}ms)`,
      );
      break;
    case 'knowledge-cache-miss':
      pushNotice(view, id, 'info', `cache miss (${part.payload.latencyMs}ms)`);
      break;
    case 'knowledge-search':
      pushNotice(
        view,
        id,
        'info',
        `search ${part.payload.layer} (${part.payload.resultCount} results)`,
      );
      break;
    case 'knowledge-quality-check':
      pushNotice(
        view,
        id,
        'info',
        `quality ${part.payload.quality} (top ${part.payload.topScore})`,
      );
      break;
    case 'knowledge-reformulation':
      pushNotice(view, id, 'info', `reformulated (${part.payload.trigger})`);
      break;
    case 'log-truncated':
      // Truncation is observable by decision, never silent: a reader must be able to tell
      // "nothing happened there" from "that history is gone".
      pushNotice(
        view,
        id,
        'info',
        `earlier history dropped (events ${part.payload.fromIndex}–${part.payload.toIndex})`,
      );
      break;
    default: {
      const _exhaustive: never = part;
      return _exhaustive;
    }
  }
}

export function reduce(events: Iterable<LoggedEvent>, prior?: TurnView): TurnView {
  const view = prior ? cloneView(prior) : emptyView();

  for (const event of events) {
    if (event.index <= view.cursor) continue;
    foldEvent(view, event);
    view.cursor = event.index;
  }

  return view;
}
