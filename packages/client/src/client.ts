import { randomUUID } from 'node:crypto';
import type { Client, Cursor, Session, Target } from './types.js';
import { LocalSession } from './local-session.js';
import { cloudflareTransport } from './transports/cloudflare.js';
import { httpTransport } from './transports/http.js';

function createLocalClient(target: Extract<Target, { kind: 'local' }>): Client {
  const { runtime, eventLog } = target;
  return {
    sessions: {
      create(): Session {
        return new LocalSession(runtime, eventLog, randomUUID());
      },
      attach(sessionId: string, cursor?: Cursor): Session {
        return new LocalSession(runtime, eventLog, sessionId, cursor);
      },
    },
  };
}

export function createClient(target: Target): Client {
  switch (target.kind) {
    case 'local':
      return createLocalClient(target);
    case 'http':
      return httpTransport(target);
    case 'cloudflare':
      return cloudflareTransport(target);
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}
