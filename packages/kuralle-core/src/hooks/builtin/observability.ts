import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ModelMessage } from 'ai';

import { TracingService } from '../../services/TracingService.js';
import type {
  HarnessHooks,
  RunContext,
  Session,
  Span,
  ToolCallRecord,
  HarnessStreamPart,
} from '../../types/index.js';
import type { Metrics, SessionEndMetadata, SessionTrace, TraceStreamEvent, TurnUsage } from '../../types/telemetry.js';

export interface ObservabilityConfig {
  /** Where to send the final SessionTrace. Default: console. */
  exporter?: 'console' | 'json' | ((trace: SessionTrace) => Promise<void>);
  /** Output file for `json` exporter. Default: `./.kuralle-traces/session-<id>.json` */
  outputPath?: string;
  /** Include message text in span events (PII risk). Default: false. */
  includeContent?: boolean;
  /** Optional metrics service for timings alongside spans. */
  metrics?: Metrics;
  /** Service name stored on spans. */
  serviceName?: string;
  /**
   * Optional live trace stream (e.g. Kuralle Studio WebSocket). Fire-and-forget;
   * keep handlers synchronous or schedule async work without blocking the harness.
   */
  traceStream?: (event: TraceStreamEvent) => void;
}

interface PerSessionState {
  rootSpan: Span;
  spans: Span[];
  turnDurationsMs: number[];
  flowTransitions: Array<{ from: string; to: string; timestamp: number }>;
  handoffs: Array<{ from: string; to: string; reason: string }>;
  extractionSubmissions: Array<{ node: string; fieldsAccepted: string[]; fieldsRejected: string[] }>;
  errors: Array<{ message: string; timestamp: number }>;
  voice: {
    bargeInCount: number;
    reconfigureCount: number;
    totalAudioInBytes: number;
    totalAudioOutBytes: number;
    timeToFirstAudioMs: number[];
  };
  perTurnUsage: TurnUsage[];
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

function computeLatency(turns: number[]): SessionTrace['latency'] {
  if (turns.length === 0) {
    return { avgTurnMs: 0, p50TurnMs: 0, p95TurnMs: 0, firstResponseMs: 0 };
  }
  const sorted = [...turns].sort((a, b) => a - b);
  const sum = turns.reduce((a, b) => a + b, 0);
  return {
    avgTurnMs: sum / turns.length,
    p50TurnMs: percentile(sorted, 50),
    p95TurnMs: percentile(sorted, 95),
    firstResponseMs: turns[0] ?? 0,
  };
}

function resolveExporter(
  config: ObservabilityConfig | undefined,
): (trace: SessionTrace) => Promise<void> {
  const exp = config?.exporter ?? 'console';
  if (exp === 'console') {
    return async (trace) => {
      console.log(formatConsoleSummary(trace));
    };
  }
  if (exp === 'json') {
    return async (trace) => {
      const out =
        config?.outputPath ?? `./.kuralle-traces/session-${trace.sessionId}.json`;
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(trace, replacerForJson, 2)}\n`, 'utf8');
    };
  }
  return exp;
}

function replacerForJson(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function formatConsoleSummary(trace: SessionTrace): string {
  const lines: string[] = [
    `[Kuralle observability] session=${trace.sessionId} agent=${trace.agentId}`,
    `  durationMs=${trace.durationMs} success=${trace.success} turns=${trace.turnCount}`,
    `  tools=${trace.toolCalls.map(t => `${t.name}(${t.durationMs}ms, ok=${t.success})`).join(', ') || '(none)'}`,
    `  latency avgTurn=${Math.round(trace.latency.avgTurnMs)}ms p50=${Math.round(trace.latency.p50TurnMs)}ms p95=${Math.round(trace.latency.p95TurnMs)}ms firstResponse=${Math.round(trace.latency.firstResponseMs)}ms`,
  ];
  if (trace.handoffs.length) {
    lines.push(`  handoffs=${trace.handoffs.map(h => `${h.from}->${h.to}`).join(', ')}`);
  }
  if (trace.errors.length) {
    lines.push(`  errors=${trace.errors.map(e => e.message).join('; ')}`);
  }
  if (trace.voice) {
    lines.push(
      `  voice bargeIn=${trace.voice.bargeInCount} reconfigure=${trace.voice.reconfigureCount}`,
    );
  }
  return lines.join('\n');
}

function collectToolCallsFromSpans(spans: Span[]): Array<{ name: string; durationMs: number; success: boolean }> {
  const out: Array<{ name: string; durationMs: number; success: boolean }> = [];
  for (const s of spans) {
    if (s.name !== 'tool.call') continue;
    const tool = s.attributes.tool;
    const name = typeof tool === 'string' ? tool : typeof tool === 'number' ? String(tool) : 'unknown';
    const start = s.startTime;
    const end = s.endTime ?? start;
    const ok = s.status !== 'error';
    out.push({ name, durationMs: Math.max(0, end - start), success: ok });
  }
  return out;
}

function buildSessionTrace(
  state: PerSessionState,
  session: Session,
  metadata: SessionEndMetadata,
  endTime: number,
): SessionTrace {
  const startTime = state.rootSpan.startTime;
  const turns = state.turnDurationsMs;
  const toolCalls = collectToolCallsFromSpans(state.spans);
  const voice = state.voice;
  const hasVoice =
    voice.bargeInCount > 0 ||
    voice.reconfigureCount > 0 ||
    voice.totalAudioInBytes > 0 ||
    voice.totalAudioOutBytes > 0 ||
    voice.timeToFirstAudioMs.length > 0;

  const usage = state.perTurnUsage;
  const lastTurn = usage.length > 0 ? usage[usage.length - 1] : undefined;
  const peakUtil = usage.reduce((m, t) => Math.max(m, t.contextUtilization ?? 0), 0);
  const totalCacheRead = usage.reduce((s, t) => s + (t.cacheReadTokens ?? 0), 0);

  return {
    sessionId: session.id,
    agentId: session.activeAgentId ?? session.currentAgent,
    startTime,
    endTime,
    durationMs: Math.max(0, endTime - startTime),
    success: metadata.success,
    turnCount: metadata.turnCount ?? turns.length,
    toolCalls,
    flowTransitions: state.flowTransitions,
    handoffs: state.handoffs,
    extractionSubmissions: state.extractionSubmissions,
    errors: state.errors,
    latency: computeLatency(turns),
    voice: hasVoice
      ? {
          bargeInCount: voice.bargeInCount,
          reconfigureCount: voice.reconfigureCount,
          totalAudioInBytes: voice.totalAudioInBytes,
          totalAudioOutBytes: voice.totalAudioOutBytes,
          avgTimeToFirstAudioMs:
            voice.timeToFirstAudioMs.length > 0
              ? voice.timeToFirstAudioMs.reduce((a, b) => a + b, 0) / voice.timeToFirstAudioMs.length
              : 0,
        }
      : undefined,
    spans: state.spans,
    ...(lastTurn
      ? {
          totalInputTokens: lastTurn.cumulativeInputTokens,
          totalOutputTokens: lastTurn.cumulativeOutputTokens,
          totalTokens: lastTurn.cumulativeTotalTokens,
          totalCacheReadTokens: totalCacheRead,
          peakContextUtilization: peakUtil,
          perTurnUsage: usage,
        }
      : {}),
  };
}

export function createObservabilityHooks(config?: ObservabilityConfig): HarnessHooks {
  const tracer = new TracingService({
    serviceName: config?.serviceName ?? 'kuralle',
  });

  const exportTrace = resolveExporter(config);
  const metrics = config?.metrics;
  const includeContent = config?.includeContent ?? false;
  const traceStream = config?.traceStream;

  const emitTrace = (event: TraceStreamEvent): void => {
    if (!traceStream) return;
    try {
      traceStream(event);
    } catch (err) {
      console.error('[Kuralle observability] traceStream error:', err);
    }
  };

  const sessionRoots = new Map<string, Span>();
  const sessionState = new Map<string, PerSessionState>();
  const toolSpans = new Map<string, Span>();
  const activeAgentSpan = new Map<string, Span>();
  /** Text-mode trace export: one debounced export per session (avoids N exports for N turns). */
  const TEXT_EXPORT_DEBOUNCE_MS = 3000;
  const pendingTextExportTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingTextExportMeta = new Map<
    string,
    { session: Session; success: boolean; agentId: string }
  >();

  const cancelPendingTextExport = (sessionId: string): void => {
    const t = pendingTextExportTimers.get(sessionId);
    if (t !== undefined) {
      clearTimeout(t);
      pendingTextExportTimers.delete(sessionId);
    }
    pendingTextExportMeta.delete(sessionId);
  };

  const ensureState = (root: Span): PerSessionState => {
    const id = root.attributes.sessionId;
    const sid = typeof id === 'string' ? id : String(id ?? '');
    let st = sessionState.get(sid);
    if (!st) {
      st = {
        rootSpan: root,
        spans: [],
        turnDurationsMs: [],
        flowTransitions: [],
        handoffs: [],
        extractionSubmissions: [],
        errors: [],
        voice: {
          bargeInCount: 0,
          reconfigureCount: 0,
          totalAudioInBytes: 0,
          totalAudioOutBytes: 0,
          timeToFirstAudioMs: [],
        },
        perTurnUsage: [],
      };
      sessionState.set(sid, st);
    }
    return st;
  };

  const pushSpan = (sessionId: string, span: Span): void => {
    const root = sessionRoots.get(sessionId);
    if (!root) return;
    const st = ensureState(root);
    st.spans.push(span);
  };

  return {
    onStart: async (ctx: RunContext) => {
      if (!ctx?.session?.id) return;
      const sid = ctx.session.id;
      if (!sessionRoots.has(sid)) {
        const span = tracer.startSpan('session', {
          sessionId: sid,
          agentId: ctx.agentId,
          service: config?.serviceName ?? 'kuralle',
        });
        sessionRoots.set(sid, span);
        const st = ensureState(span);
        st.rootSpan = span;
        st.spans.push(span);
        emitTrace({
          type: 'session:start',
          sessionId: sid,
          agentId: ctx.agentId,
          timestamp: span.startTime,
        });
        emitTrace({
          type: 'span:start',
          spanId: span.id,
          name: span.name,
          timestamp: span.startTime,
          attributes: { sessionId: sid, agentId: ctx.agentId },
        });
      }
    },

    onAgentStart: async (ctx: RunContext, agentId: string) => {
      if (!ctx?.session?.id) return;
      const root = sessionRoots.get(ctx.session.id);
      if (!root) return;

      const prev = activeAgentSpan.get(ctx.session.id);
      if (prev) {
        tracer.endSpan(prev, 'success');
      }

      const span = tracer.startSpan(
        'agent.activate',
        { agentId },
        root.id,
      );
      activeAgentSpan.set(ctx.session.id, span);
      pushSpan(ctx.session.id, span);
      emitTrace({
        type: 'span:start',
        spanId: span.id,
        parentId: root.id,
        name: span.name,
        timestamp: span.startTime,
        attributes: { agentId },
      });
    },

    onAgentEnd: async (ctx: RunContext, _agentId: string) => {
      if (!ctx?.session?.id) return;
      const span = activeAgentSpan.get(ctx.session.id);
      if (span) {
        tracer.endSpan(span, 'success');
        const durationMs = Math.max(0, (span.endTime ?? Date.now()) - span.startTime);
        emitTrace({ type: 'span:end', spanId: span.id, durationMs, status: 'success' });
        activeAgentSpan.delete(ctx.session.id);
      }
    },

    onToolCall: async (ctx: RunContext, call: ToolCallRecord) => {
      if (!ctx?.session?.id) return;
      const root = sessionRoots.get(ctx.session.id);
      if (!root) return;
      const parent = activeAgentSpan.get(ctx.session.id) ?? root;
      const span = tracer.startSpan(
        'tool.call',
        { tool: call.toolName, toolCallId: call.toolCallId },
        parent.id,
      );
      toolSpans.set(call.toolCallId, span);
      pushSpan(ctx.session.id, span);
      emitTrace({
        type: 'span:start',
        spanId: span.id,
        parentId: parent.id,
        name: 'tool.call',
        timestamp: span.startTime,
        attributes: { tool: call.toolName },
      });
      emitTrace({
        type: 'tool:call',
        toolName: call.toolName,
        args: call.args,
        timestamp: span.startTime,
      });
    },

    onToolResult: async (ctx: RunContext, call: ToolCallRecord) => {
      const span = toolSpans.get(call.toolCallId);
      if (!span) return;
      tracer.endSpan(span, call.success ? 'success' : 'error');
      const durationMs = Math.max(0, (span.endTime ?? Date.now()) - span.startTime);
      emitTrace({
        type: 'span:end',
        spanId: span.id,
        durationMs,
        status: call.success ? 'success' : 'error',
      });
      emitTrace({
        type: 'tool:result',
        toolName: call.toolName,
        durationMs,
        success: call.success,
      });
      toolSpans.delete(call.toolCallId);
      if (metrics) {
        const ms = (span.endTime ?? Date.now()) - span.startTime;
        metrics.timing('tool.duration', ms, { tool: call.toolName });
      }
    },

    onToolError: async (ctx: RunContext, call: ToolCallRecord, error: Error) => {
      const span = toolSpans.get(call.toolCallId);
      if (span) {
        tracer.endSpan(span, 'error', error);
        const durationMs = Math.max(0, (span.endTime ?? Date.now()) - span.startTime);
        emitTrace({ type: 'span:end', spanId: span.id, durationMs, status: 'error' });
        emitTrace({
          type: 'tool:result',
          toolName: call.toolName,
          durationMs,
          success: false,
        });
        toolSpans.delete(call.toolCallId);
        if (metrics) {
          const ms = (span.endTime ?? Date.now()) - span.startTime;
          metrics.timing('tool.duration', ms, { tool: call.toolName });
        }
      }
    },

    onHandoff: async (ctx: RunContext, from: string, to: string, reason: string) => {
      if (!ctx?.session?.id) return;
      const root = sessionRoots.get(ctx.session.id);
      if (!root) return;
      const st = ensureState(root);
      st.handoffs.push({ from, to, reason });
      const span = tracer.startSpan(
        'handoff',
        { from, to, reason },
        root.id,
      );
      pushSpan(ctx.session.id, span);
      tracer.endSpan(span, 'success');
    },

    onError: async (ctx: RunContext, error: Error) => {
      if (!ctx?.session?.id) return;
      const root = sessionRoots.get(ctx.session.id);
      if (root) {
        tracer.addSpanEvent(root, 'error', { message: error.message });
        const errSpan = tracer.startSpan(
          'error',
          { message: error.message },
          root.id,
        );
        pushSpan(ctx.session.id, errSpan);
        emitTrace({
          type: 'span:start',
          spanId: errSpan.id,
          parentId: root.id,
          name: 'error',
          timestamp: errSpan.startTime,
          attributes: { message: error.message },
        });
        tracer.endSpan(errSpan, 'error', error);
        const errDur = Math.max(0, (errSpan.endTime ?? Date.now()) - errSpan.startTime);
        emitTrace({ type: 'span:end', spanId: errSpan.id, durationMs: errDur, status: 'error' });
      }
      if (sessionRoots.has(ctx.session.id)) {
        const st = ensureState(sessionRoots.get(ctx.session.id)!);
        st.errors.push({ message: error.message, timestamp: Date.now() });
      }
    },

    onEnd: async (ctx: RunContext, _result: { success: boolean; error?: Error }) => {
      if (!ctx?.session?.id) return;
      const sid = ctx.session.id;
      const root = sessionRoots.get(sid);
      if (!root) return;

      const duration = Date.now() - ctx.startTime;
      const st = ensureState(root);
      st.turnDurationsMs.push(duration);

      const agentSpan = activeAgentSpan.get(sid);
      if (agentSpan) {
        tracer.endSpan(agentSpan, 'success');
        activeAgentSpan.delete(sid);
      }

      tracer.addSpanEvent(root, 'turn.end', { durationMs: duration, stepCount: ctx.stepCount });
      if (metrics) {
        metrics.timing('agent.duration', duration);
      }

      // In text mode, onSessionEnd may never fire (sessions are implicit).
      // Debounce export so multi-turn chats do not invoke the exporter every turn.
      // onSessionEnd cancels this timer and emits the final trace (realtime path).
      pendingTextExportMeta.set(sid, {
        session: ctx.session,
        success: _result.success,
        agentId: ctx.agentId,
      });
      const prevTimer = pendingTextExportTimers.get(sid);
      if (prevTimer !== undefined) {
        clearTimeout(prevTimer);
      }
      pendingTextExportTimers.set(
        sid,
        setTimeout(() => {
          pendingTextExportTimers.delete(sid);
          const meta = pendingTextExportMeta.get(sid);
          pendingTextExportMeta.delete(sid);
          const rootSnap = sessionRoots.get(sid);
          if (!rootSnap || !meta) return;
          const stSnap = ensureState(rootSnap);
          const nowSnap = Date.now();
          const textTrace = buildSessionTrace(stSnap, meta.session, {
            success: meta.success,
            durationMs: Math.max(0, nowSnap - rootSnap.startTime),
            turnCount: stSnap.turnDurationsMs.length,
            lastAgentId: meta.agentId,
            endReason: 'completed',
          }, nowSnap);
          exportTrace(textTrace).catch((err: unknown) => {
            console.error('[Kuralle observability] text-mode trace export failed:', err);
          });
        }, TEXT_EXPORT_DEBOUNCE_MS),
      );
    },

    onStreamPart: async (ctx: RunContext, part: HarnessStreamPart) => {
      if (!ctx?.session?.id) return;
      const root = sessionRoots.get(ctx.session.id);
      if (!root) return;
      const st = ensureState(root);

      if (part.type === 'flow-transition') {
        const ts = Date.now();
        st.flowTransitions.push({
          from: part.from,
          to: part.to,
          timestamp: ts,
        });
        emitTrace({ type: 'flow:transition', from: part.from, to: part.to, timestamp: ts });
        const span = tracer.startSpan(
          'flow.transition',
          { from: part.from, to: part.to },
          root.id,
        );
        pushSpan(ctx.session.id, span);
        emitTrace({
          type: 'span:start',
          spanId: span.id,
          parentId: root.id,
          name: span.name,
          timestamp: span.startTime,
          attributes: { from: part.from, to: part.to },
        });
        tracer.endSpan(span, 'success');
        const flowDur = Math.max(0, (span.endTime ?? Date.now()) - span.startTime);
        emitTrace({ type: 'span:end', spanId: span.id, durationMs: flowDur, status: 'success' });
      }

      if (part.type === 'interrupted') {
        st.voice.bargeInCount += 1;
        tracer.addSpanEvent(root, 'voice.barge_in', { reason: part.reason });
      }

      if (part.type === 'custom') {
        if (part.name === 'voice.reconfigure' || part.name === 'realtime.reconfigure') {
          st.voice.reconfigureCount += 1;
          tracer.addSpanEvent(root, 'voice.reconfigure', {});
        }
        if (part.name === 'voice.audio_in' && part.data && typeof part.data === 'object') {
          const bytes = (part.data as { bytes?: number }).bytes;
          if (typeof bytes === 'number') st.voice.totalAudioInBytes += bytes;
        }
        if (part.name === 'voice.audio_out' && part.data && typeof part.data === 'object') {
          const bytes = (part.data as { bytes?: number }).bytes;
          if (typeof bytes === 'number') st.voice.totalAudioOutBytes += bytes;
        }
        if (part.name === 'voice.time_to_first_audio' && part.data && typeof part.data === 'object') {
          const ms = (part.data as { ms?: number }).ms;
          if (typeof ms === 'number') st.voice.timeToFirstAudioMs.push(ms);
        }
        if (part.name === 'flow.extraction.submission' && part.data && typeof part.data === 'object') {
          const d = part.data as {
            node?: string;
            fieldsAccepted?: string[];
            fieldsRejected?: string[];
          };
          st.extractionSubmissions.push({
            node: typeof d.node === 'string' ? d.node : 'unknown',
            fieldsAccepted: Array.isArray(d.fieldsAccepted) ? d.fieldsAccepted.map(String) : [],
            fieldsRejected: Array.isArray(d.fieldsRejected) ? d.fieldsRejected.map(String) : [],
          });
        }
        if (part.name === 'flow.extraction.update' && part.data && typeof part.data === 'object') {
          const d = part.data as {
            nodeId?: string;
            collected?: Record<string, unknown>;
            missing?: unknown[];
          };
          const collected =
            d.collected && typeof d.collected === 'object' && d.collected !== null
              ? d.collected
              : {};
          const missing = Array.isArray(d.missing) ? d.missing.map(String) : [];
          emitTrace({
            type: 'extraction:update',
            nodeId: typeof d.nodeId === 'string' ? d.nodeId : 'unknown',
            collected,
            missing,
          });
        }
      }
    },

    onTokensUpdate: async (ctx: RunContext, turn: TurnUsage) => {
      if (!ctx?.session?.id) return;
      const root = sessionRoots.get(ctx.session.id);
      if (!root) return;
      const st = ensureState(root);
      st.perTurnUsage.push(turn);
      emitTrace({
        type: 'tokens:turn',
        sessionId: ctx.session.id,
        turn: turn.turn,
        nodeId: turn.nodeId,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        totalTokens: turn.totalTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cumulativeTotalTokens: turn.cumulativeTotalTokens,
        contextUtilization: turn.contextUtilization,
        model: turn.model,
      });
    },

    onMessage: async (ctx: RunContext, message: ModelMessage) => {
      if (!includeContent) return;
      if (!ctx?.session?.id) return;
      const root = sessionRoots.get(ctx.session.id);
      if (!root) return;
      const text =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);
      const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      tracer.addSpanEvent(root, 'message', { role: message.role, preview });
    },

    onSessionEnd: async (session: Session, metadata: SessionEndMetadata) => {
      cancelPendingTextExport(session.id);
      const root = sessionRoots.get(session.id);
      if (!root) return;

      const st = sessionState.get(session.id);
      const endTime = Date.now();
      tracer.endSpan(root, metadata.success ? 'success' : 'error');
      const rootDurationMs = Math.max(0, (root.endTime ?? endTime) - root.startTime);
      emitTrace({
        type: 'span:end',
        spanId: root.id,
        durationMs: rootDurationMs,
        status: metadata.success ? 'success' : 'error',
      });

      const trace = buildSessionTrace(
        st ?? {
          rootSpan: root,
          spans: [root],
          turnDurationsMs: [],
          flowTransitions: [],
          handoffs: [],
          extractionSubmissions: [],
          errors: [],
          voice: {
            bargeInCount: 0,
            reconfigureCount: 0,
            totalAudioInBytes: 0,
            totalAudioOutBytes: 0,
            timeToFirstAudioMs: [],
          },
          perTurnUsage: [],
        },
        session,
        metadata,
        endTime,
      );

      sessionRoots.delete(session.id);
      sessionState.delete(session.id);
      activeAgentSpan.delete(session.id);

      emitTrace({
        type: 'session:end',
        sessionId: trace.sessionId,
        success: trace.success,
        durationMs: trace.durationMs,
      });

      await exportTrace(trace);
    },
  };
}
