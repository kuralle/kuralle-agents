import type { HostedConnection } from './hostedConnection.js';
import type { LoggedEvent } from '@kuralle-agents/core';

export interface MemorySnapshot {
  blocks: Array<{ key: string; scope: string; chars: number; limit: number; content: string }>;
  extracted: Array<{ slug: string; scope: string; value: unknown; updatedAt: string }>;
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function requireAgentName(connection: HostedConnection): string {
  if (!connection.agentName) {
    throw new Error('Hosted session commands require --agent-name (or kuralle connect with --agent-name).');
  }
  return connection.agentName;
}

export async function fetchHostedMemory(
  connection: HostedConnection,
  userId: string,
  token?: string,
): Promise<MemorySnapshot> {
  const agentName = requireAgentName(connection);
  const response = await fetch(
    `${connection.server}/v1/agents/${encodeURIComponent(agentName)}/users/${encodeURIComponent(userId)}/memory`,
    { headers: authHeaders(token) },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Hosted memory failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json() as Promise<MemorySnapshot>;
}

export async function postHostedCancel(
  connection: HostedConnection,
  sessionId: string,
  token?: string,
): Promise<{ status: 'cancelled' | 'no_active_turn' }> {
  const agentName = requireAgentName(connection);
  const response = await fetch(
    `${connection.server}/v1/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(sessionId)}/cancel`,
    { method: 'POST', headers: authHeaders(token) },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Hosted cancel failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json() as Promise<{ status: 'cancelled' | 'no_active_turn' }>;
}

export async function fetchHostedSnapshot(
  connection: HostedConnection,
  sessionId: string,
  token?: string,
): Promise<{ events: LoggedEvent[]; cursor: { sessionId: string; index: number } }> {
  const agentName = requireAgentName(connection);
  const response = await fetch(
    `${connection.server}/v1/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    { headers: authHeaders(token) },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Hosted snapshot failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  return response.json() as Promise<{ events: LoggedEvent[]; cursor: { sessionId: string; index: number } }>;
}

export async function* followHostedMemoryEvents(
  connection: HostedConnection,
  sessionId: string,
  token?: string,
  from = 0,
): AsyncGenerator<LoggedEvent> {
  const agentName = requireAgentName(connection);
  const url = `${connection.server}/v1/agents/${encodeURIComponent(agentName)}/sessions/${encodeURIComponent(sessionId)}/events?from=${from}&follow=true`;
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Hosted event follow failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n');
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line) {
        yield JSON.parse(line) as LoggedEvent;
      }
      boundary = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as LoggedEvent;
}
