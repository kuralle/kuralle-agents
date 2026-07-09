import { readTranscriptDirectory, readTranscriptFile } from './io.js';
import type { ReplayStats, TranscriptEvent } from './types.js';

export class ReplayAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayAssertionError';
  }
}

function getEventType(event: TranscriptEvent): string {
  return event.part.type;
}

function isToolEventType(type: string): boolean {
  return type === 'tool-call' || type === 'tool-result' || type === 'tool-error';
}

function getToolCallId(event: TranscriptEvent): string | null {
  const id = event.part.toolCallId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function getToolName(event: TranscriptEvent): string | null {
  const toolName = event.part.toolName;
  return typeof toolName === 'string' && toolName.length > 0 ? toolName : null;
}

export class TranscriptReplay {
  private readonly events: TranscriptEvent[];

  constructor(events: TranscriptEvent[]) {
    this.events = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  static async fromFile(path: string): Promise<TranscriptReplay> {
    const events = await readTranscriptFile(path);
    return new TranscriptReplay(events);
  }

  static async fromDirectory(path: string): Promise<TranscriptReplay> {
    const events = await readTranscriptDirectory(path);
    return new TranscriptReplay(events);
  }

  allEvents(): TranscriptEvent[] {
    return [...this.events];
  }

  eventTypes(): string[] {
    return this.events.map(getEventType);
  }

  stats(): ReplayStats {
    const byType: Record<string, number> = {};
    const sessions = new Set<string>();
    const agents = new Set<string>();

    for (const event of this.events) {
      const type = getEventType(event);
      byType[type] = (byType[type] ?? 0) + 1;
      sessions.add(event.sessionId);
      agents.add(event.agentId);
    }

    return {
      totalEvents: this.events.length,
      byType,
      sessions: [...sessions].sort(),
      agents: [...agents].sort(),
    };
  }

  expectEventOrder(expectedSubsequence: string[]): this {
    if (expectedSubsequence.length === 0) return this;
    const actual = this.eventTypes();
    let cursor = 0;
    for (const next of expectedSubsequence) {
      while (cursor < actual.length && actual[cursor] !== next) {
        cursor += 1;
      }
      if (cursor >= actual.length) {
        throw new ReplayAssertionError(
          `Expected event sequence not found. Missing "${next}" after [${expectedSubsequence.join(', ')}]`
        );
      }
      cursor += 1;
    }
    return this;
  }

  expectNoErrors(): this {
    const errors = this.events.filter(event => getEventType(event) === 'error');
    if (errors.length > 0) {
      throw new ReplayAssertionError(
        `Expected no "error" events, but found ${errors.length}`
      );
    }
    return this;
  }

  expectDone(): this {
    const hasDone = this.events.some(event => getEventType(event) === 'done');
    if (!hasDone) {
      throw new ReplayAssertionError('Expected at least one "done" event');
    }
    return this;
  }

  expectToolCalled(toolName: string, minCount: number = 1): this {
    const calls = this.events.filter(
      event => getEventType(event) === 'tool-call' && getToolName(event) === toolName
    );
    if (calls.length < minCount) {
      const actualTools = this.events
        .filter(event => getEventType(event) === 'tool-call')
        .map(event => getToolName(event))
        .filter((n): n is string => Boolean(n));
      throw new ReplayAssertionError(
        `Expected tool "${toolName}" to be called at least ${minCount} time(s), found ${calls.length}.\n` +
        `  Tools actually called: ${actualTools.length > 0 ? actualTools.join(', ') : '(none)'}`
      );
    }
    return this;
  }

  expectNoToolMismatches(): this {
    const callsById = new Map<string, string>();
    let unmatchedResults = 0;
    let mismatchedToolNames = 0;

    for (const event of this.events) {
      const type = getEventType(event);
      if (!isToolEventType(type)) continue;
      const id = getToolCallId(event);
      if (!id) continue;

      if (type === 'tool-call') {
        const toolName = getToolName(event) ?? '';
        callsById.set(id, toolName);
        continue;
      }

      const callToolName = callsById.get(id);
      if (!callToolName) {
        unmatchedResults += 1;
        continue;
      }

      const resultToolName = getToolName(event) ?? '';
      if (resultToolName && callToolName && resultToolName !== callToolName) {
        mismatchedToolNames += 1;
      }
      callsById.delete(id);
    }

    if (callsById.size > 0 || unmatchedResults > 0 || mismatchedToolNames > 0) {
      const details: string[] = [];
      if (callsById.size > 0) {
        const orphans = Array.from(callsById.entries())
          .map(([id, name]) => `${name}#${id}`)
          .join(', ');
        details.push(`  Unmatched tool-call ids (no result): ${orphans}`);
      }
      if (unmatchedResults > 0) {
        details.push(`  ${unmatchedResults} tool-result event(s) without a matching tool-call id`);
      }
      if (mismatchedToolNames > 0) {
        details.push(`  ${mismatchedToolNames} tool-result event(s) whose toolName differs from the originating tool-call`);
      }
      throw new ReplayAssertionError(
        `Tool mismatch detected: unmatchedCalls=${callsById.size}, unmatchedResults=${unmatchedResults}, nameMismatches=${mismatchedToolNames}\n` +
        details.join('\n')
      );
    }
    return this;
  }
}
