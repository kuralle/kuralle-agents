import type { Session } from '../../types/session.js';
import { mergeUserInputContents, type UserInputContent } from '../userInput.js';
import { runKind, type RunState } from '../durable/types.js';

const PENDING_INPUT_KEY = '__v2_pendingUserInput';

function sessionQueue(session: Session): UserInputContent[] {
  const v = session.workingMemory[PENDING_INPUT_KEY];
  if (Array.isArray(v)) return v as UserInputContent[];
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

function usesRunBuffer(runState: RunState | undefined): runState is RunState {
  return runState !== undefined && runKind(runState) === 'flow';
}

function queue(session: Session, runState?: RunState): UserInputContent[] {
  if (usesRunBuffer(runState)) {
    return runState.pendingInput ?? [];
  }
  return sessionQueue(session);
}

function writeQueue(session: Session, runState: RunState | undefined, next: UserInputContent[]): void {
  if (usesRunBuffer(runState)) {
    if (next.length === 0) delete runState.pendingInput;
    else runState.pendingInput = next;
    return;
  }
  if (next.length === 0) delete session.workingMemory[PENDING_INPUT_KEY];
  else session.workingMemory[PENDING_INPUT_KEY] = next;
}

export function setPendingUserInput(
  session: Session,
  input: UserInputContent,
  runState?: RunState,
): void {
  writeQueue(session, runState, [...queue(session, runState), input]);
}

/** Dequeue one pending input. Built-in drivers drain the full queue via {@link consumeAllPendingUserInput}. */
export function consumePendingUserInput(session: Session, runState?: RunState): UserInputContent {
  const q = [...queue(session, runState)];
  const next = q.shift() ?? '';
  writeQueue(session, runState, q);
  return next;
}

/** Drain the pending-input FIFO and merge into one turn (mid-turn enqueue-merge). */
export function consumeAllPendingUserInput(
  session: Session,
  runState?: RunState,
): UserInputContent | undefined {
  const q = queue(session, runState);
  writeQueue(session, runState, []);
  return mergeUserInputContents(q);
}

export function peekPendingUserInput(
  session: Session,
  runState?: RunState,
): UserInputContent | undefined {
  return queue(session, runState)[0];
}

export function hasPendingUserInput(session: Session, runState?: RunState): boolean {
  return queue(session, runState).length > 0;
}

export function syncPendingUserInput(source: Session, target: Session): void {
  const pending = sessionQueue(source);
  if (pending.length > 0) {
    target.workingMemory[PENDING_INPUT_KEY] = [...pending];
  } else {
    delete target.workingMemory[PENDING_INPUT_KEY];
  }
}
