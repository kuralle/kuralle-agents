import type { TurnResult } from '../types/channel.js';
import type { HarnessStreamPart, TurnHandle } from '../types/stream.js';
import type { AgentSpan, AgentTrace } from '../types/trace.js';
import type { RunOptions } from './Runtime.js';

export interface TraceRecorderOptions {
  sessionId?: string;
  input?: unknown;
  onSpan?: (span: AgentSpan) => void;
}

export class TraceRecorder {
  private readonly trace: AgentTrace;
  private readonly root: AgentSpan;
  private currentFlow?: AgentSpan;
  private currentNode?: AgentSpan;
  private readonly openTools: AgentSpan[] = [];
  private readonly toolCallIds = new Map<AgentSpan, string | undefined>();
  private readonly emitted = new Set<string>();
  private readonly onSpan?: (span: AgentSpan) => void;

  constructor(options: TraceRecorderOptions = {}) {
    const startedAt = Date.now();
    const sessionId = options.sessionId ?? '';
    const traceId = crypto.randomUUID().replaceAll('-', '');
    this.onSpan = options.onSpan;
    this.root = {
      traceId,
      spanId: newSpanId(),
      name: 'turn',
      kind: 'turn',
      startTime: startedAt,
      status: 'ok',
      attributes: {
        sessionId,
        ...(options.input !== undefined ? { input: toJsonValue(options.input) } : {}),
      },
    };
    this.trace = {
      traceId,
      sessionId,
      spans: [this.root],
      answer: '',
      usedTool: false,
      toolCalls: [],
      toolResults: [],
      startedAt,
    };
  }

  record(part: HarnessStreamPart): void {
    try {
      const at = Date.now();
      switch (part.type) {
        case 'text-delta':
          this.trace.answer += part.delta;
          break;
        case 'flow-enter':
          this.closeNode(at);
          this.closeFlow(at);
          this.currentFlow = this.openSpan({
            name: `flow:${part.flow}`,
            kind: 'flow',
            parentSpanId: this.root.spanId,
            at,
            attributes: { activeFlow: part.flow },
          });
          break;
        case 'flow-end':
          this.closeNode(at);
          this.closeFlow(at);
          break;
        case 'node-enter':
          this.closeNode(at);
          this.currentNode = this.openSpan({
            name: `node:${part.nodeName}`,
            kind: 'node',
            parentSpanId: this.currentFlow?.spanId ?? this.root.spanId,
            at,
            attributes: {
              ...(this.currentFlow ? { activeFlow: activeFlowName(this.currentFlow) } : {}),
              nodeId: part.nodeName,
            },
          });
          break;
        case 'node-exit':
          this.closeNode(at);
          break;
        case 'tool-call': {
          const span = this.openSpan({
            name: `tool:${part.toolName}`,
            kind: 'tool',
            parentSpanId: this.currentNode?.spanId ?? this.root.spanId,
            at,
            attributes: {
              ...(this.currentFlow ? { activeFlow: activeFlowName(this.currentFlow) } : {}),
              ...(this.currentNode ? { nodeId: nodeName(this.currentNode) } : {}),
              toolName: part.toolName,
              input: toJsonValue(part.args),
            },
          });
          this.toolCallIds.set(span, part.toolCallId);
          this.openTools.push(span);
          this.trace.usedTool = true;
          this.trace.toolCalls.push({ name: part.toolName, args: toJsonValue(part.args) });
          break;
        }
        case 'tool-result': {
          this.trace.usedTool = true;
          const result = toJsonValue(part.result);
          this.trace.toolResults.push({ name: part.toolName, result });
          const span = this.takeToolSpan(part.toolName, part.toolCallId) ??
            this.openSpan({
              name: `tool:${part.toolName}`,
              kind: 'tool',
              parentSpanId: this.currentNode?.spanId ?? this.root.spanId,
              at,
              attributes: {
                ...(this.currentFlow ? { activeFlow: activeFlowName(this.currentFlow) } : {}),
                ...(this.currentNode ? { nodeId: nodeName(this.currentNode) } : {}),
                toolName: part.toolName,
              },
            });
          span.attributes.output = result;
          span.endTime = at;
          this.emitSpan(span);
          break;
        }
        case 'handoff': {
          const span = this.openSpan({
            name: `handoff:${part.targetAgent}`,
            kind: 'handoff',
            parentSpanId: this.root.spanId,
            at,
            attributes: { handoffTo: part.targetAgent },
          });
          span.endTime = at;
          this.emitSpan(span);
          break;
        }
        case 'error': {
          const span = this.openTools.at(-1) ?? this.currentNode ?? this.currentFlow ?? this.root;
          span.status = 'error';
          span.attributes.error = part.error;
          this.root.status = 'error';
          this.root.attributes.error = part.error;
          break;
        }
        case 'done':
          this.setSessionId(part.sessionId);
          this.root.attributes.output = this.trace.answer;
          if (part.usage) {
            if (typeof part.usage.inputTokens === 'number') this.root.attributes.tokensIn = part.usage.inputTokens;
            if (typeof part.usage.outputTokens === 'number') this.root.attributes.tokensOut = part.usage.outputTokens;
          }
          this.close(at);
          break;
      }
    } catch {
      // Tracing is observational: malformed telemetry must never affect the run.
    }
  }

  finish(result: TurnResult): AgentTrace {
    try {
      if (!this.trace.answer) {
        this.trace.answer = result.text;
      }
      this.root.attributes.output = this.trace.answer;
      this.close(Date.now());
    } catch {
      // Returning a partial trace is preferable to changing run behavior.
    }
    return this.trace;
  }

  private openSpan(args: {
    name: string;
    kind: AgentSpan['kind'];
    parentSpanId: string;
    at: number;
    attributes: Omit<AgentSpan['attributes'], 'sessionId'>;
  }): AgentSpan {
    const span: AgentSpan = {
      traceId: this.trace.traceId,
      spanId: newSpanId(),
      parentSpanId: args.parentSpanId,
      name: args.name,
      kind: args.kind,
      startTime: args.at,
      status: 'ok',
      attributes: { sessionId: this.trace.sessionId, ...args.attributes },
    };
    this.trace.spans.push(span);
    return span;
  }

  private takeToolSpan(toolName: string, toolCallId?: string): AgentSpan | undefined {
    const index = this.openTools.findIndex((span) => {
      const spanCallId = this.toolCallIds.get(span);
      return toolCallId ? spanCallId === toolCallId : span.attributes.toolName === toolName;
    });
    if (index < 0) return undefined;
    const span = this.openTools.splice(index, 1)[0];
    if (span) this.toolCallIds.delete(span);
    return span;
  }

  private closeTools(at: number): void {
    for (const span of this.openTools.splice(0)) {
      span.endTime ??= at;
      this.toolCallIds.delete(span);
      this.emitSpan(span);
    }
  }

  private closeNode(at: number): void {
    this.closeTools(at);
    if (this.currentNode) {
      this.currentNode.endTime ??= at;
      this.emitSpan(this.currentNode);
      this.currentNode = undefined;
    }
  }

  private closeFlow(at: number): void {
    if (this.currentFlow) {
      this.currentFlow.endTime ??= at;
      this.emitSpan(this.currentFlow);
      this.currentFlow = undefined;
    }
  }

  private setSessionId(sessionId: string): void {
    this.trace.sessionId = sessionId;
    for (const span of this.trace.spans) {
      span.attributes.sessionId = sessionId;
    }
  }

  private close(at: number): void {
    this.closeNode(at);
    this.closeFlow(at);
    this.trace.endedAt ??= at;
    this.root.endTime ??= at;
    this.emitSpan(this.root);
  }

  private emitSpan(span: AgentSpan): void {
    if (this.emitted.has(span.spanId) || span.endTime === undefined) return;
    this.emitted.add(span.spanId);
    try {
      this.onSpan?.(structuredClone(span));
    } catch {
      // A tracing callback is never allowed to change run behavior.
    }
  }
}

export async function runOnce(
  runtime: { run(opts: RunOptions): TurnHandle },
  opts: RunOptions,
): Promise<AgentTrace> {
  const handle = runtime.run(opts);
  const recorder = new TraceRecorder({ sessionId: opts.sessionId, input: opts.input });
  for await (const part of handle.events) {
    recorder.record(part);
  }
  return recorder.finish(await handle);
}

function activeFlowName(span: AgentSpan): string {
  return span.attributes.activeFlow ?? span.name.slice('flow:'.length);
}

function nodeName(span: AgentSpan): string {
  return span.attributes.nodeId ?? span.name.slice('node:'.length);
}

function newSpanId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

function toJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, seen));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    try {
      output[key] = toJsonValue(entry, seen);
    } catch {
      output[key] = '[Unserializable]';
    }
  }
  return output;
}
