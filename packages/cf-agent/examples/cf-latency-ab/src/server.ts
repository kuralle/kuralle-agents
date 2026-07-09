/// <reference types="@cloudflare/workers-types" />
/**
 * cf-latency-ab — A/B latency probe for the declared grounding contract (0.7.1).
 *
 * One answering agent (FAQ answers + two flows) deployed under two Durable
 * Object classes that differ ONLY in `knowledge.autoRetrieve`:
 *   - GuaranteedDO  → autoRetrieve: true  (runtime pre-injects every host turn)
 *   - OnDemandDO    → autoRetrieve: false (model calls knowledge_search on demand)
 *
 * Each DO instance (addressed by sessionId) holds one Kuralle Runtime with an
 * in-DO MemoryStore, so a scripted multi-turn conversation persists across
 * requests. `POST /run/:mode/:sessionId` runs one turn and streams the raw
 * Kuralle event stream as SSE; the client (measure.mjs) times TTFT per turn and
 * counts `knowledge-search` events — the routing-turn retrieval tax shows up as
 * the per-turn delta between the two modes.
 */
import { DurableObject } from 'cloudflare:workers';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import {
  createRuntime,
  defineAgent,
  defineFlow,
  reply,
  MemoryStore,
  type HarnessConfig,
  type Runtime,
} from '@kuralle-agents/core';

type KnowledgeConfig = NonNullable<HarnessConfig['knowledge']>;

interface Env {
  OPENAI_API_KEY: string;
  GuaranteedDO: DurableObjectNamespace;
  OnDemandDO: DurableObjectNamespace;
}

// --- Knowledge base: small FAQ corpus with a REAL embedding retriever --------
// Retrieval latency = one OpenAI embeddings round-trip + cosine. This is the
// cost a guaranteed-grounding agent pays on EVERY host turn (incl. routing
// turns that never use it); an on-demand agent pays it only when answering.
const FAQ_DOCS: { id: string; text: string }[] = [
  { id: 'hours', text: 'Our clinic is open Monday to Friday 8am to 6pm, and Saturday 9am to 1pm. We are closed on Sundays and public holidays.' },
  { id: 'parking', text: 'Free patient parking is available in the rear lot off Maple Street. Street parking is metered until 6pm.' },
  { id: 'insurance', text: 'We accept most major insurance plans including Aetna, BlueCross, and Cigna. Please bring your insurance card to every visit.' },
  { id: 'refunds', text: 'Cancellations made at least 24 hours in advance receive a full refund. Late cancellations are charged a 50% fee.' },
  { id: 'newpatient', text: 'New patients should arrive 15 minutes early to complete intake forms. Bring a photo ID and your medication list.' },
  { id: 'telehealth', text: 'Telehealth video appointments are available for follow-ups and prescription refills. Ask the front desk to set one up.' },
];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// Module-scoped so the FAQ corpus is embedded once per isolate (not once per
// DO instance) — the per-query embedding is the real per-turn retrieval tax we
// measure; the one-time corpus embed must not skew turn-1 of every session.
let DOC_VECTORS: Promise<number[][]> | undefined;

function buildEmbeddingRetriever(apiKey: string): KnowledgeConfig['retriever'] {
  async function embed(texts: string[]): Promise<number[][]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    if (!res.ok) {
      throw new Error(`embeddings ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  }

  return {
    retrieve: async (query: string, options?: { topK?: number }) => {
      if (!DOC_VECTORS) {
        DOC_VECTORS = embed(FAQ_DOCS.map((d) => d.text));
      }
      const docVectors = await DOC_VECTORS;
      const [q] = await embed([query]);
      const topK = options?.topK ?? 3;
      return FAQ_DOCS
        .map((doc, i) => ({ doc, score: cosine(q, docVectors[i]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(({ doc, score }) => ({
          id: doc.id,
          text: doc.text,
          sourceId: doc.id,
          score,
          relevanceScore: score,
        }));
    },
  };
}

// --- The agent: FAQ answers + two flows (so some host turns route) -----------
function buildAgent(model: LanguageModel, autoRetrieve: boolean) {
  const bookStart = reply({
    id: 'book_start',
    instructions: 'Ask the patient for their preferred appointment date and time.',
    next: () => ({ end: 'booked' }),
  });
  const bookFlow = defineFlow({
    name: 'book_appointment',
    description: 'Book a clinic appointment: ask for date and time.',
    start: bookStart,
    nodes: [bookStart],
  });

  const complaintStart = reply({
    id: 'complaint_start',
    instructions: 'Ask the patient to describe their complaint and a callback number.',
    next: () => ({ end: 'filed' }),
  });
  const complaintFlow = defineFlow({
    name: 'file_complaint',
    description: 'File a formal complaint: ask for details and a callback number.',
    start: complaintStart,
    nodes: [complaintStart],
  });

  return defineAgent({
    id: 'clinic',
    instructions:
      'You are the front desk for a medical clinic. Answer questions about hours, parking, ' +
      'insurance, refunds, and visits concisely from the knowledge base. If the user wants to ' +
      'book an appointment or file a complaint, call the matching control tool.',
    model,
    knowledge: { autoRetrieve },
    flows: [bookFlow, complaintFlow],
  });
}

function sseFromHandle(handle: { events: AsyncIterable<unknown> }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const part of handle.events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: message })}\n\n`));
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

abstract class LatencyDO extends DurableObject<Env> {
  protected abstract autoRetrieve: boolean;
  private runtime?: Runtime;

  private getRuntime(): Runtime {
    if (!this.runtime) {
      const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
      const model = openai('gpt-4o-mini');
      this.runtime = createRuntime({
        agents: [buildAgent(model, this.autoRetrieve)],
        defaultAgentId: 'clinic',
        defaultModel: model,
        sessionStore: new MemoryStore(),
        knowledge: {
          retriever: buildEmbeddingRetriever(this.env.OPENAI_API_KEY),
          defaults: { topK: 3, maxOutputTokens: 500 },
        },
      });
    }
    return this.runtime;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId') ?? 'default';
    const { message } = (await request.json()) as { message: string };
    const handle = this.getRuntime().run({ input: message, sessionId });
    return sseFromHandle(handle);
  }
}

export class GuaranteedDO extends LatencyDO {
  protected autoRetrieve = true;
}
export class OnDemandDO extends LatencyDO {
  protected autoRetrieve = false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/run\/(guaranteed|on-demand)\/([^/]+)$/);
    if (request.method === 'POST' && match) {
      const [, mode, sessionId] = match;
      const ns = mode === 'guaranteed' ? env.GuaranteedDO : env.OnDemandDO;
      const stub = ns.get(ns.idFromName(sessionId));
      const doUrl = new URL(request.url);
      doUrl.searchParams.set('sessionId', sessionId);
      return stub.fetch(new Request(doUrl, { method: 'POST', body: await request.text(), headers: request.headers }));
    }
    if (url.pathname === '/') {
      return new Response('cf-latency-ab: POST /run/{guaranteed|on-demand}/{sessionId} { "message": "..." }\n');
    }
    return new Response('not found', { status: 404 });
  },
};
