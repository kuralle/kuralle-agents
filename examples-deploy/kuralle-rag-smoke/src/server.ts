/**
 * kuralle-rag-smoke — live verification of the VecGrep-gap sprint claims on
 * real Cloudflare infrastructure (spike test, torn down after capture):
 *
 *   GET /latency       — Workers AI query-embedding latency via the real
 *                        kuralle path (AiSdkEmbedder + workers-ai-provider,
 *                        @cf/baai/bge-m3), 16 sequential embeds, p50/p95.
 *   GET /do/fts5       — Fts5KeywordIndex on real Durable Object SQLite:
 *                        FTS5 availability, multilingual (Tamil/Sinhala +
 *                        trigram CJK), persistence across calls.
 *   GET /do/pipeline   — RagPipeline with SqlIngestManifest on DO SQLite:
 *                        incremental ingest (second ingest = 0 embeds) and
 *                        the embedder provider lock throwing live.
 */
import { DurableObject } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';
import { AiSdkEmbedder } from '../../../packages/rag/dist/embedders/AiSdkEmbedder.js';
import { RagPipeline } from '../../../packages/rag/dist/pipeline/RagPipeline.js';
import { SqlIngestManifest } from '../../../packages/rag/dist/pipeline/IngestManifest.js';
import { InMemoryVectorStore } from '../../../packages/rag/dist/vectorStores/InMemoryVectorStore.js';
import { createMarkdownChunker } from '../../../packages/rag/dist/chunkers.js';
import { Fts5KeywordIndex } from '../../../packages/rag/dist/search/Fts5KeywordIndex.js';
import { createSqlExecutor } from '../../../packages/cf-agent/dist/sqlExecutor.js';
import type { Embedder } from '../../../packages/rag/dist/types.js';

interface Env {
  AI: Ai;
  RAG_SMOKE: DurableObjectNamespace<RagSmoke>;
}

const EMBED_MODEL = '@cf/baai/bge-m3';

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

const QUERIES = [
  'what is the refund policy',
  'how long does shipping take',
  'is there a warranty on devices',
  'how do I cancel my subscription',
  'do you deliver internationally',
  'what payment methods are accepted',
  'how do I track my order',
  'can I exchange a damaged item',
  'what is the loyalty program',
  'how do I upgrade my plan',
  'when does my voucher expire',
  'how do I reach a support agent',
  'what is the return window',
  'are there express delivery options',
  'how are refunds processed',
  'what does the setup manual cover',
];

const DOCS = [
  { id: 'doc-a', text: '# Refunds\n\nRefund policy: thirty days, original payment method, ref-code-A1.' },
  { id: 'doc-b', text: '# Shipping\n\nFree shipping above fifty dollars; express in two days.' },
  { id: 'doc-c', text: '# Warranty\n\nWarranty covers manufacturing defects for two years.' },
];

class CountingEmbedder implements Embedder {
  textsEmbedded = 0;
  constructor(private readonly inner: Embedder) {}
  get dimension() { return this.inner.dimension; }
  get id() { return this.inner.id; }
  async embed(text: string) { this.textsEmbedded += 1; return this.inner.embed(text); }
  async embedMany(texts: string[]) { this.textsEmbedded += texts.length; return this.inner.embedMany(texts); }
}

export class RagSmoke extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/do/fts5') return Response.json(await this.fts5());
      if (path === '/do/pipeline') return Response.json(await this.pipeline());
      return new Response('not found', { status: 404 });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  private async fts5() {
    const sql = createSqlExecutor(this.ctx.storage.sql);

    const idx = new Fts5KeywordIndex({ sql });
    const preexistingDocs = idx.size; // >0 on later calls = survived in DO SQLite
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

    return {
      preexistingDocs,
      persistedAcrossCalls: preexistingDocs > 0,
      size: idx.size,
      english: idx.search('refund policy', 1)[0]?.id ?? null,
      tamil: idx.search('கொள்கை', 1)[0]?.id ?? null,
      sinhala: idx.search('ප්‍රතිපත්තිය', 1)[0]?.id ?? null,
      japaneseTrigram: trigram.search('ポリシー', 1)[0]?.id ?? null,
      chineseTrigram: trigram.search('退款政策', 1)[0]?.id ?? null,
    };
  }

  private async pipeline() {
    const sql = createSqlExecutor(this.ctx.storage.sql);
    const workersai = createWorkersAI({ binding: this.env.AI });
    const mk = () => new CountingEmbedder(
      new AiSdkEmbedder({ model: workersai.textEmbeddingModel(EMBED_MODEL) }),
    );

    const manifestPreexisted =
      (await new SqlIngestManifest({ sql }).load('smoke-kb')) !== undefined;

    const store = new InMemoryVectorStore();
    const keywordIndex = new Fts5KeywordIndex({ sql, tableName: 'kw_pipeline' });

    const first = mk();
    await new RagPipeline({
      embedder: first,
      vectorStore: store,
      chunker: createMarkdownChunker(),
      indexName: 'smoke-kb',
      manifest: new SqlIngestManifest({ sql }),
      keywordIndex,
    }).ingest(DOCS);

    const second = mk();
    await new RagPipeline({
      embedder: second,
      vectorStore: store,
      chunker: createMarkdownChunker(),
      indexName: 'smoke-kb',
      manifest: new SqlIngestManifest({ sql }),
      keywordIndex,
    }).ingest(DOCS);

    // Provider lock: a different model identity must throw at retrieve.
    let lockThrew = false;
    let lockMessage = '';
    const impostor: Embedder = {
      dimension: 1024,
      id: 'smoke/other-model',
      embed: async () => new Array(1024).fill(0),
      embedMany: async (texts) => texts.map(() => new Array(1024).fill(0)),
    };
    try {
      await new RagPipeline({
        embedder: impostor,
        vectorStore: store,
        chunker: createMarkdownChunker(),
        indexName: 'smoke-kb',
        manifest: new SqlIngestManifest({ sql }),
      }).retrieve('refund policy');
    } catch (err) {
      lockThrew = true;
      lockMessage = String(err).slice(0, 160);
    }

    return {
      manifestPreexisted,
      firstIngestTexts: first.textsEmbedded,
      secondIngestTexts: second.textsEmbedded,
      keywordIndexSize: keywordIndex.size,
      lockThrew,
      lockMessage,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/latency') {
      const workersai = createWorkersAI({ binding: env.AI });
      const embedder = new AiSdkEmbedder({ model: workersai.textEmbeddingModel(EMBED_MODEL) });
      const latencies: number[] = [];
      let dimension = 0;
      for (const q of QUERIES) {
        const t0 = Date.now();
        const vec = await embedder.embed(q);
        latencies.push(Date.now() - t0);
        dimension = vec.length;
      }
      return Response.json({
        model: EMBED_MODEL,
        dimension,
        samples: latencies.length,
        p50Ms: Math.round(percentile(latencies, 50)),
        p95Ms: Math.round(percentile(latencies, 95)),
        meanMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        latenciesMs: latencies,
      });
    }

    if (url.pathname.startsWith('/do/')) {
      const session = url.searchParams.get('session') ?? 'smoke';
      const stub = env.RAG_SMOKE.get(env.RAG_SMOKE.idFromName(session));
      return stub.fetch(request);
    }

    return new Response('kuralle-rag-smoke: /latency /do/fts5 /do/pipeline', { status: 200 });
  },
};
