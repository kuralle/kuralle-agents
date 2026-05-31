import crypto from 'node:crypto';
import { HarnessStreamPart, RunContext, Session } from '../types/index.js';
import { isRecord } from '../utils/isRecord.js';

export class SessionEventManager {
    private assistantTextKey = '__ariaAssistantText';
    private readonly runtimeEventLogKey = 'runtimeEventLog';
    private readonly runtimeEventLogMaxEntries = 2000;

    constructor(private helpers: {
        touchSession: (session: Session) => void;
        getSessionTurn: (session: Session) => number;
    }) { }

    private appendRuntimeEvent(context: RunContext, entry: Record<string, unknown>): void {
        const key = this.runtimeEventLogKey;
        const current = context.session.workingMemory[key];
        const events = Array.isArray(current) ? [...current] : [];
        events.push(entry);
        const overflow = events.length - this.runtimeEventLogMaxEntries;
        if (overflow > 0) {
            events.splice(0, overflow);
        }
        context.session.workingMemory[key] = events;
        this.helpers.touchSession(context.session);
    }

    private toEventLogValue(value: unknown, depth: number = 0): unknown {
        if (value === null || value === undefined) {
            return value;
        }
        if (depth >= 5) {
            return '[truncated]';
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (value instanceof Error) {
            return { name: value.name, message: value.message };
        }
        if (Array.isArray(value)) {
            return value.slice(0, 50).map(item => this.toEventLogValue(item, depth + 1));
        }
        if (typeof value === 'function') {
            return '[function]';
        }
        if (isRecord(value)) {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value).slice(0, 50)) {
                out[k] = this.toEventLogValue(v, depth + 1);
            }
            return out;
        }
        return value;
    }

    private flushAssistantFinalEvent(context: RunContext, trigger: 'turn-end' | 'done' | 'error'): void {
        const textRaw = context.session.workingMemory[this.assistantTextKey];
        const text = (typeof textRaw === 'string' ? textRaw : '').trim();
        if (text.length > 0) {
            this.appendRuntimeEvent(context, {
                id: crypto.randomUUID(),
                sessionId: context.session.id,
                agentId: context.agentId,
                turn: this.helpers.getSessionTurn(context.session),
                type: 'assistant_final',
                trigger,
                text,
                timestamp: new Date().toISOString(),
            });
        }
        delete context.session.workingMemory[this.assistantTextKey];
    }

    recordRuntimeEvent(context: RunContext, part: HarnessStreamPart): void {
        const base = {
            id: crypto.randomUUID(),
            sessionId: context.session.id,
            agentId: context.agentId,
            turn: this.helpers.getSessionTurn(context.session),
            timestamp: new Date().toISOString(),
        };

        switch (part.type) {
            case 'text-delta': {
                const prevRaw = context.session.workingMemory[this.assistantTextKey];
                const prev = typeof prevRaw === 'string' ? prevRaw : '';
                context.session.workingMemory[this.assistantTextKey] = prev + part.text;
                return;
            }
            case 'input':
                this.appendRuntimeEvent(context, { ...base, type: 'user', text: part.text, userId: part.userId });
                return;
            case 'tool-call':
                this.appendRuntimeEvent(context, {
                    ...base,
                    type: 'tool_call',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    args: this.toEventLogValue(part.args),
                });
                return;
            case 'tool-result':
                this.appendRuntimeEvent(context, {
                    ...base,
                    type: 'tool_result',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    result: this.toEventLogValue(part.result),
                });
                return;
            case 'tool-error':
                this.appendRuntimeEvent(context, {
                    ...base,
                    type: 'tool_error',
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    error: part.error,
                });
                return;
            case 'flow-transition':
                this.appendRuntimeEvent(context, {
                    ...base,
                    type: 'transition',
                    kind: 'flow',
                    from: part.from,
                    to: part.to,
                });
                return;
            case 'handoff':
                this.appendRuntimeEvent(context, {
                    ...base,
                    type: 'transition',
                    kind: 'handoff',
                    from: part.from,
                    to: part.to,
                    reason: part.reason,
                });
                return;
            case 'turn-end':
                this.flushAssistantFinalEvent(context, 'turn-end');
                return;
            case 'done':
                this.flushAssistantFinalEvent(context, 'done');
                return;
            case 'error':
                this.flushAssistantFinalEvent(context, 'error');
                return;
            default:
                return;
        }
    }

    cleanupSession(session: Session): void {
        delete session.workingMemory[this.assistantTextKey];
    }
}
