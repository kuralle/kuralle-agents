import type { TurnResult } from '../types/channel.js';
import type { StreamPart, TurnHandle } from '../types/stream.js';
import type { AgentSpan, AgentTrace, DeploymentTraceContext } from '../types/trace.js';
import type { RunOptions } from './Runtime.js';

export interface TraceRecorderOptions {
  sessionId?: string;
  agentId?: string;
  input?: unknown;
  deployment?: DeploymentTraceContext;
  onSpan?: (span: AgentSpan) => void;
}

export class TraceRecorder {
  private readonly trace: AgentTrace;
  private readonly root: AgentSpan;
  private currentFlow?: AgentSpan;
  private currentNode?: AgentSpan;
  private readonly openTools: AgentSpan[] = [];
  private readonly toolCallIds = new Map<AgentSpan, string | undefined>();
  private readonly openLlms = new Map<string, AgentSpan>();
  private readonly emitted = new Set<string>();
  private readonly onSpan?: (span: AgentSpan) => void;
  private readonly deployment: Partial<AgentSpan['attributes']>;
  private currentAgentId?: string;

  constructor(options: TraceRecorderOptions = {}) {
    const startedAt = Date.now();
    const sessionId = options.sessionId ?? '';
    const traceId = crypto.randomUUID().replaceAll('-', '');
    this.onSpan = options.onSpan;
    this.deployment = options.deployment ? { ...options.deployment } : {};
    this.currentAgentId = options.agentId;
    this.root = {
      traceId,
      spanId: newSpanId(),
      name: 'turn',
      kind: 'turn',
      startTime: startedAt,
      status: 'ok',
      attributes: {
        ...this.deployment,
        sessionId,
        ...(options.agentId ? { agentId: options.agentId } : {}),
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

  setInitiatingAgent(agentId: string): void {
    this.currentAgentId = agentId;
    this.root.attributes.agentId = agentId;
  }

  recordSkillSnapshot(agentId: string, contentHash: string): void {
    const hashes = this.root.attributes.skillContentHashes ?? {};
    hashes[agentId] = contentHash;
    this.root.attributes.skillContentHashes = hashes;
    this.root.attributes.skillContentHash ??= contentHash;
  }

  record(part: StreamPart): void {
    try {
      const at = Date.now();
      switch (part.type) {
        case 'text-delta':
          if (part.payload.delta && this.root.attributes.ttftMs === undefined) {
            this.root.attributes.ttftMs = at - this.root.startTime;
          }
          this.trace.answer += part.payload.delta;
          break;
        case 'flow-enter':
          this.closeNode(at);
          this.closeFlow(at);
          this.currentFlow = this.openSpan({
            name: `flow:${part.payload.flow}`,
            kind: 'flow',
            parentSpanId: this.root.spanId,
            at,
            attributes: { activeFlow: part.payload.flow },
          });
          break;
        case 'flow-end':
          this.closeNode(at);
          this.closeFlow(at);
          break;
        case 'node-enter':
          this.closeNode(at);
          this.currentNode = this.openSpan({
            name: `node:${part.payload.nodeName}`,
            kind: 'node',
            parentSpanId: this.currentFlow?.spanId ?? this.root.spanId,
            at,
            attributes: {
              ...(this.currentFlow ? { activeFlow: activeFlowName(this.currentFlow) } : {}),
              nodeId: part.payload.nodeName,
            },
          });
          break;
        case 'node-exit':
          this.closeNode(at);
          break;
        case 'tool-call': {
          const span = this.openSpan({
            name: `tool:${part.payload.toolName}`,
            kind: 'tool',
            parentSpanId: this.currentNode?.spanId ?? this.root.spanId,
            at,
            attributes: {
              ...(this.currentFlow ? { activeFlow: activeFlowName(this.currentFlow) } : {}),
              ...(this.currentNode ? { nodeId: nodeName(this.currentNode) } : {}),
              toolName: part.payload.toolName,
              input: toJsonValue(part.payload.args),
              ...(part.payload.imperative ? { imperative: true } : {}),
            },
          });
          this.toolCallIds.set(span, part.payload.toolCallId);
          this.openTools.push(span);
          this.trace.usedTool = true;
          this.trace.toolCalls.push({
            name: part.payload.toolName,
            args: toJsonValue(part.payload.args),
          });
          break;
        }
        case 'tool-result': {
          this.trace.usedTool = true;
          const result = toJsonValue(part.payload.result);
          this.trace.toolResults.push({ name: part.payload.toolName, result });
          const span = this.takeToolSpan(part.payload.toolName, part.payload.toolCallId) ??
            this.openSpan({
              name: `tool:${part.payload.toolName}`,
              kind: 'tool',
              parentSpanId: this.currentNode?.spanId ?? this.root.spanId,
              at,
              attributes: {
                ...(this.currentFlow ? { activeFlow: activeFlowName(this.currentFlow) } : {}),
                ...(this.currentNode ? { nodeId: nodeName(this.currentNode) } : {}),
                toolName: part.payload.toolName,
              },
            });
          span.attributes.output = result;
          span.endTime = at;
          this.emitSpan(span);
          break;
        }
        case 'model-call-start': {
          const parentSpanId = part.payload.controlPath
            ? this.root.spanId
            : (this.currentNode?.spanId ?? this.root.spanId);
          const span = this.openSpan({
            name: `llm:${part.payload.modelId}`,
            kind: 'llm',
            parentSpanId,
            at,
            attributes: {
              ...(this.currentFlow ? { activeFlow: activeFlowName(this.currentFlow) } : {}),
              ...(this.currentNode ? { nodeId: nodeName(this.currentNode) } : {}),
              modelId: part.payload.modelId,
              step: part.payload.step,
              ...(part.payload.controlPath ? { controlPath: true } : {}),
            },
          });
          this.openLlms.set(part.payload.callId, span);
          break;
        }
        case 'model-call-end': {
          const span = this.openLlms.get(part.payload.callId);
          if (!span) break;
          this.openLlms.delete(part.payload.callId);
          if (typeof part.payload.inputTokens === 'number') {
            span.attributes.inputTokens = part.payload.inputTokens;
          }
          if (typeof part.payload.outputTokens === 'number') {
            span.attributes.outputTokens = part.payload.outputTokens;
          }
          if (typeof part.payload.cacheReadTokens === 'number') {
            span.attributes.cacheReadTokens = part.payload.cacheReadTokens;
          }
          if (typeof part.payload.cacheWriteTokens === 'number') {
            span.attributes.cacheWriteTokens = part.payload.cacheWriteTokens;
          }
          if (part.payload.finishReason !== undefined) {
            span.attributes.finishReason = part.payload.finishReason;
          }
          span.endTime = at;
          this.emitSpan(span);
          break;
        }
        case 'turn-end':
          if (this.currentNode && part.payload.rendered) {
            this.currentNode.attributes.rendered = part.payload.rendered;
          }
          break;
        case 'handoff': {
          const handoffFrom = this.currentAgentId;
          const span = this.openSpan({
            name: `handoff:${part.payload.targetAgent}`,
            kind: 'handoff',
            parentSpanId: this.root.spanId,
            at,
            attributes: {
              ...(handoffFrom ? { handoffFrom } : {}),
              handoffTo: part.payload.targetAgent,
            },
          });
          span.endTime = at;
          this.emitSpan(span);
          this.currentAgentId = part.payload.targetAgent;
          break;
        }
        case 'custom': {
          if (part.payload.name !== 'flow.extraction.update' || !this.currentNode) break;
          const data = part.payload.data as { slotSources?: Record<string, 'deterministic' | 'model'> };
          if (!data?.slotSources || typeof data.slotSources !== 'object') break;
          this.currentNode.attributes.slotSources = {
            ...this.currentNode.attributes.slotSources,
            ...data.slotSources,
          };
          break;
        }
        case 'error': {
          const span = this.openTools.at(-1) ?? this.currentNode ?? this.currentFlow ?? this.root;
          span.status = 'error';
          span.attributes.error = part.payload.error;
          this.root.status = 'error';
          this.root.attributes.error = part.payload.error;
          break;
        }
        case 'done':
          this.setSessionId(part.payload.sessionId);
          this.root.attributes.output = this.trace.answer;
          if (part.payload.usage) {
            if (typeof part.payload.usage.inputTokens === 'number') {
              this.root.attributes.tokensIn = part.payload.usage.inputTokens;
            }
            if (typeof part.payload.usage.outputTokens === 'number') {
              this.root.attributes.tokensOut = part.payload.usage.outputTokens;
            }
            if (typeof part.payload.usage.contextTokens === 'number') {
              this.root.attributes.contextTokens = part.payload.usage.contextTokens;
            }
            if (typeof part.payload.usage.cacheReadTokens === 'number') {
              this.root.attributes.cacheReadTokens = part.payload.usage.cacheReadTokens;
            }
            if (typeof part.payload.usage.cacheWriteTokens === 'number') {
              this.root.attributes.cacheWriteTokens = part.payload.usage.cacheWriteTokens;
            }
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
      attributes: {
        ...this.deployment,
        sessionId: this.trace.sessionId,
        ...(this.currentAgentId ? { agentId: this.currentAgentId } : {}),
        ...args.attributes,
      },
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

  private closeLlms(at: number): void {
    for (const [callId, span] of this.openLlms) {
      this.openLlms.delete(callId);
      span.endTime ??= at;
      this.emitSpan(span);
    }
  }

  private closeNode(at: number): void {
    this.closeTools(at);
    this.closeLlms(at);
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

/**
 * What the standalone {@link runOnce} needs from a runtime. `run` is required;
 * the optional accessors let it resolve the same agent `Runtime.runOnce` would.
 *
 * It must NOT call `runtime.runOnce` — that method delegates here, so delegating
 * back is infinite recursion.
 */
export interface RunOnceRuntime {
  run(opts: RunOptions): TurnHandle;
  getSessionStore?(): { get(id: string): Promise<{ activeAgentId?: string; currentAgent?: string } | null> };
  getDefaultAgentId?(): string;
}

export async function runOnce(
  runtime: RunOnceRuntime,
  opts: RunOptions,
): Promise<AgentTrace> {
  // Resolve attribution the same way Runtime.runOnce does: caller's agentId
  // first, then persisted state, then the runtime default. Without this the
  // standalone helper produced spans with no `agentId` and handoff spans with
  // no `handoffFrom` — the exact feature it is documented to provide.
  let agentId = opts.agentId;
  if (!agentId && opts.sessionId && runtime.getSessionStore) {
    const existing = await runtime.getSessionStore().get(opts.sessionId);
    agentId = existing?.activeAgentId ?? existing?.currentAgent;
  }
  agentId ??= runtime.getDefaultAgentId?.();

  const handle = runtime.run(opts);
  const recorder = new TraceRecorder({
    sessionId: opts.sessionId,
    agentId,
    input: opts.input,
  });
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
