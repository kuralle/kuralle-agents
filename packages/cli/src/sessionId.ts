import { randomUUID } from 'node:crypto';

/** Local session id helper — core's `newSessionId` is not on the public index. */
export function newSessionId(): string {
  return randomUUID();
}