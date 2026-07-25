import { describe, expect, it } from 'bun:test';
import { PART_CHANNEL } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';

function readNarrowedPayload(part: StreamPart): unknown {
  switch (part.type) {
    case 'text-start':
    case 'text-end':
      return part.payload.id;
    case 'text-delta':
      return part.payload.delta;
    case 'text-cancel':
      return part.payload.reason;
    case 'tool-call':
      return part.payload.args;
    case 'tool-result':
      return part.payload.result;
    case 'flow-enter':
      return part.payload.flow;
    case 'flow-end':
      return part.payload.reason;
    case 'node-enter':
    case 'node-exit':
      return part.payload.nodeName;
    case 'flow-transition':
      return part.payload.to;
    case 'handoff':
      return part.payload.targetAgent;
    case 'interrupted':
      return part.payload.lastStep;
    case 'paused':
      return part.payload.waitingFor;
    case 'conversation-outcome':
      return part.payload.outcome;
    case 'interactive':
      return part.payload.options;
    case 'turn-end':
      return part.payload;
    case 'pipeline-validation-block':
      return part.payload.rationale;
    case 'safety-blocked':
      return part.payload.moderator;
    case 'wake':
      return part.payload.reason;
    case 'escalation':
      return part.payload.outcome;
    case 'context-compacted':
      return part.payload.summarizedCount;
    case 'compaction-skipped':
      return part.payload.reason;
    case 'context-overflow-recovered':
      return part.payload.strippedCount;
    case 'error':
      return part.payload.error;
    case 'custom':
      return part.payload.data;
    case 'done':
      return part.payload.sessionId;
    case 'knowledge-cache-hit':
      return part.payload.resultCount;
    case 'knowledge-cache-miss':
      return part.payload.latencyMs;
    case 'knowledge-search':
      return part.payload.layer;
    case 'knowledge-quality-check':
      return part.payload.quality;
    case 'knowledge-reformulation':
      return part.payload.reformulatedQuery;
    default: {
      const unreachable: never = part;
      return unreachable;
    }
  }
}

describe('public StreamPart export', () => {
  it('classifies every publicly exported variant', () => {
    expect(Object.keys(PART_CHANNEL)).toHaveLength(32);
    expect(readNarrowedPayload).toBeFunction();
  });
});
