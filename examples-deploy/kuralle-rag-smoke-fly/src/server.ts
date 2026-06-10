/**
 * kuralle-rag-smoke-fly — live verification of the VecGrep-gap sprint on a
 * deployed Bun container (Fly.io spike test, destroyed after capture):
 *
 *   GET /fts5     — Fts5KeywordIndex over bun:sqlite (file-backed):
 *                   multilingual + persistence across requests.
 *   GET /pipeline — RagPipeline + SqlIngestManifest on the same SQLite file:
 *                   incremental ingest (second ingest = 0 embeds) and the
 *                   embedder provider lock, with a deterministic embedder.
 *   GET /latency  — OpenAI query-embed latency from the Fly datacenter
 *                   (the cloud-embed tax measured server-side).
 */
import { Database } from 'bun:sqlite';
import { RagPipeline } from '../../../packages/kuralle-rag/dist/pipeline/RagPipeline.js';
import { SqlIngestManifest } from '../../../packages/kuralle-rag/dist/pipeline/IngestManifest.js';
import { InMemoryVectorStore } from '../../../packages/kuralle-rag/dist/vectorStores/InMemoryVectorStore.js';
import { createMarkdownChunker } from '../../../packages/kuralle-rag/dist/chunkers.js';
import { Fts5KeywordIndex } from '../../../packages/kuralle-rag/dist/search/Fts5KeywordIndex.js';
import type { SqlExecutor } from '../../../packages/kuralle-rag/dist/sql.js';
import type { Embedder } from '../../../packages/kuralle-rag/dist/types.js';

const DB_PATH = '/tmp/kuralle-rag-smoke.sqlite';

function bunSqlExecutor(db: Database): SqlExecutor {
  return (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const query = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? '?' : ''),
      '',
    );
    return db.query(query).all(...(values as never[])) as T[];
  }) as SqlExecutor;
}

// Deterministic embedder (same scheme as the repo bench fixtures).
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

class HashEmbedder implements Embedder {
  readonly dimension = 256;
  textsEmbedded = 0;
  constructor(readonly id: string = 'fly-smoke/hash-model-a') {}
  private one(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    for (const t of text.toLowerCase().split(/\s+/)) {
      if (t.length >= 2) vec[fnv1a(t) % this.dimension] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
  async embed(text: string) { this.textsEmbedded += 1; return this.one(text); }
  async embedMany(texts: string[]) { this.textsEmbedded += texts.length; return texts.map((t) => this.one(t)); }
}

const DOCS = [
  { id: 'doc-a', text: '# Refunds\n\nRefund policy: thirty days, original payment method.' },
  { id: 'doc-b', text: '# Shipping\n\nFree shipping above fifty dollars; express in two days.' },
  { id: 'doc-c', text: '# Warranty\n\nWarranty covers manufacturing defects for two years.' },
];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function fts5() {
  const db = new Database(DB_PATH);
  const sql = bunSqlExecutor(db);
  const idx = new Fts5KeywordIndex({ sql });
  const preexistingDocs = idx.size;
  if (preexistingDocs === 0) {
    idx.add([
      { id: 'en', text: 'Our refund policy allows returns within thirty days.' },
      { id: 'ta', text: 'பணத்தைத் திரும்பப் பெறுதல் கொள்கை முப்பது நாட்கள்' },
      { id: 'si', text: 'මුදල් ආපසු ගෙවීමේ ප්‍රතිපත්තිය දින තිහක්' },
    ]);
  }
  const trigram = new Fts5KeywordIndex({ sql, tableName: 'kw_trigram', tokenize: 'trigram' });
  if (trigram.size === 0) {
    trigram.add([
      { id: 'ja', text: '返金ポリシーは配達後30日以内です' },
      { id: 'zh', text: '退款政策为送达后三十天内' },
    ]);
  }
  const out = {
    preexistingDocs,
    persistedAcrossRequests: preexistingDocs > 0,
    english: idx.search('refund policy', 1)[0]?.id ?? null,
    tamil: idx.search('கொள்கை', 1)[0]?.id ?? null,
    sinhala: idx.search('ප්‍රතිපත්තිය', 1)[0]?.id ?? null,
    japaneseTrigram: trigram.search('ポリシー', 1)[0]?.id ?? null,
    chineseTrigram: trigram.search('退款政策', 1)[0]?.id ?? null,
  };
  db.close();
  return out;
}

async function pipeline() {
  const db = new Database(DB_PATH);
  const sql = bunSqlExecutor(db);
  const manifestPreexisted =
    (await new SqlIngestManifest({ sql }).load('fly-kb')) !== undefined;

  const store = new InMemoryVectorStore();
  const keywordIndex = new Fts5KeywordIndex({ sql, tableName: 'kw_pipeline' });

  const mkPipeline = (embedder: Embedder) =>
    new RagPipeline({
      embedder,
      vectorStore: store,
      chunker: createMarkdownChunker(),
      indexName: 'fly-kb',
      manifest: new SqlIngestManifest({ sql }),
      keywordIndex,
    });

  const first = new HashEmbedder();
  await mkPipeline(first).ingest(DOCS);
  const second = new HashEmbedder();
  await mkPipeline(second).ingest(DOCS);

  let lockThrew = false;
  let lockMessage = '';
  try {
    const impostor = new HashEmbedder('fly-smoke/other-model');
    await mkPipeline(impostor).retrieve('refund policy');
  } catch (err) {
    lockThrew = true;
    lockMessage = String(err).slice(0, 160);
  }

  const out = {
    manifestPreexisted,
    firstIngestTexts: first.textsEmbedded,
    secondIngestTexts: second.textsEmbedded,
    keywordIndexSize: keywordIndex.size,
    lockThrew,
    lockMessage,
  };
  db.close();
  return out;
}

async function latency() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OPENAI_API_KEY not set' };
  const queries = [
    'what is the refund policy', 'how long does shipping take',
    'is there a warranty on devices', 'how do I cancel my subscription',
    'do you deliver internationally', 'what payment methods are accepted',
    'how do I track my order', 'can I exchange a damaged item',
    'what is the loyalty program', 'how do I upgrade my plan',
    'when does my voucher expire', 'how do I reach a support agent',
    'what is the return window', 'are there express delivery options',
    'how are refunds processed', 'what does the setup manual cover',
  ];
  const latencies: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: q }),
    });
    if (!res.ok) return { error: `OpenAI ${res.status}` };
    await res.json();
    latencies.push(performance.now() - t0);
  }
  return {
    model: 'text-embedding-3-small',
    region: process.env.FLY_REGION ?? 'unknown',
    samples: latencies.length,
    p50Ms: Math.round(percentile(latencies, 50)),
    p95Ms: Math.round(percentile(latencies, 95)),
    meanMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    latenciesMs: latencies.map((l) => Math.round(l)),
  };
}

Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/fts5') return Response.json(await fts5());
      if (path === '/pipeline') return Response.json(await pipeline());
      if (path === '/latency') return Response.json(await latency());
      return new Response('kuralle-rag-smoke-fly: /fts5 /pipeline /latency');
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
});

console.log('kuralle-rag-smoke-fly listening');
