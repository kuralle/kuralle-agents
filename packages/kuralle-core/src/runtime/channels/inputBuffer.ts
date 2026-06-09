import type { Session } from '../../types/session.js';
import type { UserInputContent } from '../userInput.js';

const PENDING_INPUT_KEY = '__v2_pendingUserInput';

function queue(session: Session): UserInputContent[] {
  const v = session.workingMemory[PENDING_INPUT_KEY];
  if (Array.isArray(v)) return v as UserInputContent[];
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

export function setPendingUserInput(session: Session, input: UserInputContent): void {
  session.workingMemory[PENDING_INPUT_KEY] = [...queue(session), input];
}

export function consumePendingUserInput(session: Session): UserInputContent {
  const q = queue(session);
  const next = q.shift() ?? '';
  if (q.length === 0) delete session.workingMemory[PENDING_INPUT_KEY];
  else session.workingMemory[PENDING_INPUT_KEY] = q;
  return next;
}

export function peekPendingUserInput(session: Session): UserInputContent | undefined {
  return queue(session)[0];
}

export function hasPendingUserInput(session: Session): boolean {
  return queue(session).length > 0;
}
