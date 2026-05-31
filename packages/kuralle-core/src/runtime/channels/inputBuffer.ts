import type { Session } from '../../types/session.js';

const PENDING_INPUT_KEY = '__v2_pendingUserInput';

export function setPendingUserInput(session: Session, input: string): void {
  session.workingMemory[PENDING_INPUT_KEY] = input;
}

export function consumePendingUserInput(session: Session): string {
  const value = session.workingMemory[PENDING_INPUT_KEY];
  delete session.workingMemory[PENDING_INPUT_KEY];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('No buffered user input for awaitUser');
  }
  return value;
}

export function peekPendingUserInput(session: Session): string | undefined {
  const value = session.workingMemory[PENDING_INPUT_KEY];
  return typeof value === 'string' ? value : undefined;
}

export function hasPendingUserInput(session: Session): boolean {
  return peekPendingUserInput(session) !== undefined;
}
