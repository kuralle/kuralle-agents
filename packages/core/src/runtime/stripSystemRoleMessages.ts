import type { ModelMessage } from 'ai';
import type { RunState } from './durable/types.js';
import type { RunStore } from './durable/RunStore.js';
import { addSystemNote, readSystemNote, type NoteLifetime } from './systemNotes.js';

/** Legacy compaction summaries were stored as the first model message with this prefix. */
export const COMPACTION_SUMMARY_PREFIX =
  '[Conversation summary — earlier turns were compacted]';

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

function routeLegacySystemMessage(
  text: string,
  index: number,
): {
  text: string;
  tag: string;
  lifetime: NoteLifetime;
} {
  const trimmed = text.trim();
  // Unknown legacy text gets a per-message tag. A shared tag would make the second such
  // message replace the first, which is the data loss this whole function exists to avoid.
  const unknownTag = `legacy-system-message-${index}`;
  if (!trimmed) {
    return { text: trimmed, tag: unknownTag, lifetime: 'run' };
  }
  if (trimmed.startsWith(COMPACTION_SUMMARY_PREFIX)) {
    return { text: trimmed, tag: 'compaction-summary', lifetime: 'run' };
  }
  if (trimmed.startsWith('Previous conversation summary:')) {
    return { text: trimmed, tag: 'context-reset-summary', lifetime: 'run' };
  }
  if (trimmed.startsWith('[A human agent handled')) {
    return { text: trimmed, tag: 'escalation-resume', lifetime: 'run' };
  }
  if (trimmed.startsWith('[Scheduled wake:')) {
    return { text: trimmed, tag: 'wake', lifetime: 'turn' };
  }
  return { text: trimmed, tag: unknownTag, lifetime: 'run' };
}

/**
 * Remove `role: 'system'` entries from a run's model message array. Legacy compaction
 * summaries and other framework notes are routed into the system-note channel so context
 * is preserved. Idempotent: already-clean state is not mutated.
 */
export function sanitizeRunStateMessages(runState: RunState): boolean {
  const systemIndices: number[] = [];
  for (let index = 0; index < runState.messages.length; index += 1) {
    if (runState.messages[index]?.role === 'system') {
      systemIndices.push(index);
    }
  }
  if (systemIndices.length === 0) {
    return false;
  }

  for (const index of systemIndices) {
    const message = runState.messages[index]!;
    const text = messageText(message);
    if (!text.trim()) {
      continue;
    }
    const routed = routeLegacySystemMessage(text, index);
    const existing = readSystemNote(runState, routed.tag);
    if (existing === routed.text) {
      continue;
    }
    // Never overwrite a note that already exists. The semantic tag is only safe when it is
    // free: a second message routing to the same tag (escalation-resume was pushed once per
    // resume) would otherwise discard the first, and a stale legacy message would clobber a
    // fresher note written by current code. Falling back to a per-index tag preserves both.
    const tag = existing === undefined ? routed.tag : `legacy-${routed.tag}-${index}`;
    addSystemNote(runState, routed.text, { lifetime: routed.lifetime, tag });
  }

  runState.messages = runState.messages.filter((message) => message.role !== 'system');
  return true;
}

/** Caller-supplied message arrays must not seed system-role entries into the transcript. */
export function rejectSystemRoleInCallerMessages(
  messages: readonly ModelMessage[],
  context: 'seedMessages' | 'historyDelta',
): void {
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'system') {
      throw new Error(
        `${context} must not contain role: 'system' messages (index ${index}); ` +
          'use callerInstructions or system notes instead',
      );
    }
  }
}

/** Load run state and lazily strip legacy system-role messages, persisting when changed. */
export async function loadSanitizedRunState(
  runStore: RunStore,
  runId: string,
): Promise<RunState | null> {
  const runState = await runStore.getRunState(runId);
  if (!runState) {
    return null;
  }
  if (sanitizeRunStateMessages(runState)) {
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
  }
  return runState;
}
