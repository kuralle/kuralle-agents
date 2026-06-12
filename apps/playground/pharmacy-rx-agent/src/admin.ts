/// <reference types="@cloudflare/workers-types" />

/**
 * Admin inbox plumbing (pure — no `cloudflare:workers` import so it stays unit
 * testable). The ConversationRegistry DO lives in `registry-do.ts`. Durable
 * Objects can't be enumerated by the platform, so every conversation upserts a
 * one-row summary into a single registry DO; the dashboard lists from the
 * registry, then fetches a thread's full history from that thread's own DO.
 */

export interface ThreadSummary {
  /** Routing id: WhatsApp DO name `wa:<pid>:<from>`, or the web DO hex id. */
  id: string;
  channel: 'whatsapp' | 'web';
  customer: string;
  lastText: string;
  lastRole: 'user' | 'assistant';
  lastAt: number;
}

export interface AdminMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/** Best-effort upsert into the registry (never throws into the turn). */
export async function recordThread(
  registry: DurableObjectNamespace,
  summary: ThreadSummary,
): Promise<void> {
  try {
    const stub = registry.get(registry.idFromName('global'));
    await stub.fetch('https://do/upsert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary),
    });
  } catch {
    /* inbox indexing is best-effort; a failed upsert must not break the chat */
  }
}

/** Normalize CF UIMessages (web, parts-based) to a flat admin transcript. */
export function normalizeUiMessages(messages: Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>): AdminMessage[] {
  const out: AdminMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const text = (m.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

type ModelContent = string | Array<{ type: string; text?: string }>;
/** Normalize Kuralle ModelMessages (WhatsApp, content-based) to a transcript. */
export function normalizeModelMessages(messages: Array<{ role: string; content: ModelContent }>): AdminMessage[] {
  const out: AdminMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('');
    if (text.trim()) out.push({ role: m.role, text: text.trim() });
  }
  return out;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'x-admin-token,content-type',
};

export function corsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
