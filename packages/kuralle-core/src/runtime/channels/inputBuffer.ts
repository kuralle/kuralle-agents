import type { Session } from '../../types/session.js';

const PENDING_INPUT_KEY = '__v2_pendingUserInput';

function queue(session: Session): string[] {
  const v = session.workingMemory[PENDING_INPUT_KEY];
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

export function setPendingUserInput(session: Session, input: string): void {
  session.workingMemory[PENDING_INPUT_KEY] = [...queue(session), input];
}

export function consumePendingUserInput(session: Session): string {
  const q = queue(session);
  const next = q.shift() ?? '';
  if (q.length === 0) delete session.workingMemory[PENDING_INPUT_KEY];
  else session.workingMemory[PENDING_INPUT_KEY] = q;
  return next;
}

export function peekPendingUserInput(session: Session): string | undefined {
  return queue(session)[0];
}

export function hasPendingUserInput(session: Session): boolean {
  return queue(session).length > 0;
}
