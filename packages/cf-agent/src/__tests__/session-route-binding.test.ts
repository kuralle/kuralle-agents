import { describe, expect, it } from 'bun:test';
import {
  readSnapshot,
  type LoggedEvent,
  type StreamPart,
} from '@kuralle-agents/core';
import { Database } from 'bun:sqlite';
import { dispatchSessionRequest } from '../sessionHttp.js';
import { SqlSessionEventLog } from '../SqlSessionEventLog.js';
import type { SqlExecutor } from '../types.js';

const sessionId = 'bind-sess';
const agent = 'support';
const tenantId = 'tenant-a';
const userId = 'user-a';

function bunSql(db: Database = new Database(':memory:')): SqlExecutor {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, part, index) => acc + part + (index < values.length ? '?' : ''),
      '',
    ).trim();
    if (!query) return [];
    if (/^\s*(SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
      return db.prepare(query).all(...values);
    }
    db.prepare(query).run(...values);
    return [];
  }) as SqlExecutor;
}

function textDelta(delta: string): StreamPart {
  return { channel: 'client', type: 'text-delta', payload: { id: 't1', delta } };
}

function principal(request: Request) {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return { tenantId: auth.slice('Bearer '.length), userId };
}

describe('cf-agent session route binding', () => {
  it('snapshot transport returns the same status and body as the shared handler', async () => {
    const sql = bunSql();
    const eventLog = new SqlSessionEventLog(sql);
    await eventLog.append(sessionId, [textDelta('bound')], 'run-1');

    const deps = {
      eventLog,
      memory: { readBlocks: async () => [], readExtracted: async () => [] },
      cancelTurn: async () => 'no_active_turn' as const,
      memoryOwner: () => null,
    };
    const handlerOutcome = await readSnapshot(deps, sessionId, { limit: '10' }, 'safe');

    const response = await dispatchSessionRequest({
      request: new Request(`http://do/v1/agents/${agent}/sessions/${sessionId}/snapshot?limit=10`, {
        headers: { authorization: `Bearer ${tenantId}` },
      }),
      boundSessionId: sessionId,
      boundAgentId: agent,
      eventLog,
      sql,
      cancelTurn: () => false,
      resolvePrincipal: principal,
    });

    expect(response?.status).toBe(handlerOutcome.status);
    expect(await response!.json()).toEqual(handlerOutcome.body);
  });

  it('events transport preserves handler ndjson payload shape', async () => {
    const sql = bunSql();
    const eventLog = new SqlSessionEventLog(sql);
    await eventLog.append(sessionId, [textDelta('stream')], 'run-1');

    const response = await dispatchSessionRequest({
      request: new Request(`http://do/v1/agents/${agent}/sessions/${sessionId}/events?from=0&follow=false`, {
        headers: { authorization: `Bearer ${tenantId}` },
      }),
      boundSessionId: sessionId,
      boundAgentId: agent,
      eventLog,
      sql,
      cancelTurn: () => false,
      resolvePrincipal: principal,
    });
    const text = await response!.text();
    const events = text.trim().split('\n').map((line) => JSON.parse(line) as LoggedEvent);
    expect(events).toHaveLength(1);
    expect(events[0]!.part.type).toBe('text-delta');
  });
});
