import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RagPipeline } from '../src/pipeline/RagPipeline.js';
import {
  InMemoryIngestManifest,
  SqlIngestManifest,
} from '../src/pipeline/IngestManifest.js';
import { createMarkdownChunker } from '../src/chunkers.js';
import { InMemoryVectorStore } from '../src/vectorStores/InMemoryVectorStore.js';
import { BM25Index } from '../src/search/BM25Index.js';
import type { SqlExecutor } from '../src/sql.js';
import { CountingEmbedder, HashEmbedder } from './embedder-fixture.js';
import type { Document } from '../src/types.js';

const INDEX = 'manifest-test';

const docs = (suffix = ''): Document[] => [
  { id: 'doc-a', text: `# A\n\nRefund policy details${suffix}.` },
  { id: 'doc-b', text: '# B\n\nShipping and delivery windows.' },
];

function makePipeline(opts?: {
  store?: InMemoryVectorStore;
  embedder?: CountingEmbedder;
  manifest?: InMemoryIngestManifest | SqlIngestManifest;
  seed?: string;
  keywordIndex?: BM25Index;
}) {
  const store = opts?.store ?? new InMemoryVectorStore();
  const embedder =
    opts?.embedder ?? new CountingEmbedder(new HashEmbedder({ seed: opts?.seed ?? 'model-a' }));
  const pipeline = new RagPipeline({
    embedder,
    vectorStore: store,
    chunker: createMarkdownChunker(),
    indexName: INDEX,
    manifest: opts?.manifest,
    keywordIndex: opts?.keywordIndex,
  });
  return { store, embedder, pipeline };
}

function bunSqlExecutor(db: Database): SqlExecutor {
  return (<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): T[] => {
    const query = strings.reduce(
      (acc, part, i) => acc + part + (i < values.length ? '?' : ''),
      '',
    );
    return db.query(query).all(...(values as never[])) as T[];
  }) as SqlExecutor;
}

describe('test:pipeline-manifest incremental ingest', () => {
  it('skips unchanged documents entirely on re-ingest (zero embeds)', async () => {
    const manifest = new InMemoryIngestManifest();
    const { embedder, pipeline } = makePipeline({ manifest });

    await pipeline.ingest(docs());
    expect(embedder.textsEmbedded).toBeGreaterThan(0);

    embedder.reset();
    await pipeline.ingest(docs());
    expect(embedder.textsEmbedded).toBe(0);
  });

  it('re-embeds only the changed document and removes its stale chunks', async () => {
    const manifest = new InMemoryIngestManifest();
    const keywordIndex = new BM25Index();
    const { store, embedder, pipeline } = makePipeline({ manifest, keywordIndex });

    // doc-a gets two sections initially → two chunks
    const v1: Document[] = [
      { id: 'doc-a', text: '# A\n\nRefund policy.\n\n## A2\n\nSecond section.' },
      { id: 'doc-b', text: '# B\n\nShipping windows.' },
    ];
    await pipeline.ingest(v1);
    const before = await store.describeIndex(INDEX);
    const kwBefore = keywordIndex.size;

    embedder.reset();
    // doc-a shrinks to one section → old second chunk must be deleted
    const v2: Document[] = [
      { id: 'doc-a', text: '# A\n\nRefund policy, updated.' },
      { id: 'doc-b', text: '# B\n\nShipping windows.' },
    ];
    await pipeline.ingest(v2);

    expect(embedder.textsEmbedded).toBe(1); // only doc-a's single new chunk
    const after = await store.describeIndex(INDEX);
    expect(after.count).toBe(before.count - 1); // stale chunk removed
    expect(keywordIndex.size).toBe(kwBefore - 1);
  });

  it('keeps full re-embed behavior when no manifest is configured', async () => {
    const { embedder, pipeline } = makePipeline();
    await pipeline.ingest(docs());
    const fresh = embedder.textsEmbedded;
    embedder.reset();
    await pipeline.ingest(docs());
    expect(embedder.textsEmbedded).toBe(fresh);
  });

  it('re-seeds an empty keyword index from skipped docs without embedding (restart)', async () => {
    const manifest = new InMemoryIngestManifest();
    const store = new InMemoryVectorStore();
    const first = makePipeline({ store, manifest, keywordIndex: new BM25Index() });
    await first.pipeline.ingest(docs());

    // Restart: fresh in-memory keyword index, same manifest/store. Without
    // recovery, manifest-skip would leave it empty and hybrid retrieval
    // would silently degrade to vector-only.
    const freshKeyword = new BM25Index();
    const second = makePipeline({ store, manifest, keywordIndex: freshKeyword });
    await second.pipeline.ingest(docs());

    expect(second.embedder.textsEmbedded).toBe(0); // chunk-only reseed
    expect(freshKeyword.size).toBeGreaterThan(0);
    expect(freshKeyword.search('refund', 1)[0]?.id).toContain('doc-a');
  });

  it('preserves the recorded embedder identity through a skip-only ingest', async () => {
    const manifest = new InMemoryIngestManifest();
    const store = new InMemoryVectorStore();
    const first = makePipeline({ store, manifest });
    await first.pipeline.ingest(docs());
    const recorded = (await manifest.load(INDEX))?.embedder;
    expect(recorded?.dimension).toBe(256);

    // Restart with a dimension-unknown embedder (caches on first embed,
    // which never happens when everything is skipped).
    const lazy = new HashEmbedder({ seed: 'model-a' });
    const lazyNoDim: typeof lazy = Object.create(lazy, {
      dimension: { value: undefined },
      id: { value: lazy.id },
    });
    const second = new RagPipeline({
      embedder: lazyNoDim,
      vectorStore: store,
      chunker: createMarkdownChunker(),
      indexName: INDEX,
      manifest,
    });
    await second.ingest(docs()); // all skipped — zero embeds
    expect((await manifest.load(INDEX))?.embedder?.dimension).toBe(256); // not erased
  });

  it('persists across pipeline instances via SqlIngestManifest (restart simulation)', async () => {
    const db = new Database(':memory:');
    const sql = bunSqlExecutor(db);
    const store = new InMemoryVectorStore();

    const first = makePipeline({ store, manifest: new SqlIngestManifest({ sql }) });
    await first.pipeline.ingest(docs());

    // "Restart": new manifest + pipeline over the same database and store.
    const second = makePipeline({ store, manifest: new SqlIngestManifest({ sql }) });
    await second.pipeline.ingest(docs());
    expect(second.embedder.textsEmbedded).toBe(0);
  });
});

describe('test:pipeline-manifest embedder lock', () => {
  it('throws on ingest with a different same-dimension model', async () => {
    const manifest = new InMemoryIngestManifest();
    const store = new InMemoryVectorStore();
    const a = makePipeline({ store, manifest, seed: 'model-a' });
    await a.pipeline.ingest(docs());

    const b = makePipeline({ store, manifest, seed: 'model-b' });
    await expect(b.pipeline.ingest(docs(' v2'))).rejects.toThrow(/built with embedder/);
  });

  it('throws on retrieve with a different same-dimension model', async () => {
    const manifest = new InMemoryIngestManifest();
    const store = new InMemoryVectorStore();
    const a = makePipeline({ store, manifest, seed: 'model-a' });
    await a.pipeline.ingest(docs());

    const b = makePipeline({ store, manifest, seed: 'model-b' });
    await expect(b.pipeline.retrieve('refund policy')).rejects.toThrow(/built with embedder/);
  });

  it('throws on a dimension mismatch even when model ids are absent', async () => {
    const manifest = new InMemoryIngestManifest();
    const store = new InMemoryVectorStore();

    const stripId = (inner: HashEmbedder) =>
      ({
        embed: (t: string) => inner.embed(t),
        embedMany: (t: string[]) => inner.embedMany(t),
        dimension: inner.dimension,
      });

    const a = new RagPipeline({
      embedder: stripId(new HashEmbedder({ seed: 'model-a', dimension: 64 })),
      vectorStore: store,
      chunker: createMarkdownChunker(),
      indexName: INDEX,
      manifest,
    });
    await a.ingest(docs());

    const b = new RagPipeline({
      embedder: stripId(new HashEmbedder({ seed: 'model-a', dimension: 128 })),
      vectorStore: store,
      chunker: createMarkdownChunker(),
      indexName: INDEX,
      manifest,
    });
    await expect(b.retrieve('refund policy')).rejects.toThrow(/dimension/i);
  });

  it('allows the same model to keep ingesting and retrieving', async () => {
    const manifest = new InMemoryIngestManifest();
    const store = new InMemoryVectorStore();
    const a = makePipeline({ store, manifest, seed: 'model-a' });
    await a.pipeline.ingest(docs());

    const again = makePipeline({ store, manifest, seed: 'model-a' });
    await again.pipeline.ingest([{ id: 'doc-c', text: '# C\n\nWarranty terms.' }]);
    const results = await again.pipeline.retrieve('warranty');
    expect(results.length).toBeGreaterThan(0);
  });
});
