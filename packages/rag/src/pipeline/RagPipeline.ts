import type {
  Embedder,
  VectorStoreCore,
  Chunker,
  Reranker,
  Document,
  RetrievalResult,
  RetrievalOptions,
  Retriever,
} from '../types.js';
import { hasIndexAdmin } from '../types.js';
import type { KeywordIndex } from '../search/KeywordIndex.js';
import {
  sha256Hex,
  type IngestManifest,
  type IngestManifestData,
} from './IngestManifest.js';

export interface RagPipelineOptions {
  /** Embedder for converting text to vectors. */
  embedder: Embedder;
  /**
   * Vector store for persistent storage and similarity search.
   *
   * `ensureIndex()` additionally requires `VectorStoreIndexAdmin` to
   * provision indexes at runtime; passing a Core-only adapter (edge
   * stores such as Cloudflare Vectorize or Upstash Vector whose indexes
   * are provisioned out-of-band) is supported — `ensureIndex()` becomes
   * a no-op on those stores (REQ-17).
   */
  vectorStore: VectorStoreCore;
  /** Chunker for splitting documents into chunks. */
  chunker: Chunker;
  /** Index name for this pipeline's data. */
  indexName: string;
  /** Optional reranker for post-retrieval refinement. */
  reranker?: Reranker;
  /** Default topK for retrieval. Default: 10. */
  topK?: number;
  /** Distance metric for index creation. Default: 'cosine'. */
  metric?: 'cosine' | 'euclidean' | 'dotproduct';
  /** Batch size for embedMany calls. Default: 100. */
  batchSize?: number;
  /**
   * Persistent ingest manifest. When provided, the pipeline:
   *   - locks the index to the embedder that built it ({@link Embedder.id}
   *     + dimension) and throws on mismatch at ingest AND retrieve time —
   *     a different same-dimension model silently corrupts relevance;
   *   - skips unchanged documents on re-ingest (SHA-256 content hash);
   *   - deletes stale chunks of changed documents (when the store
   *     supports admin deletes).
   * Without a manifest, every ingest re-embeds everything and no
   * embedder lock is enforced (previous behavior).
   */
  manifest?: IngestManifest;
  /**
   * Keyword index kept in sync with ingestion (the keyword tier for
   * `FusionRetriever`/`HybridRetriever`). Chunk ids match the vector
   * entry ids (`${docId}:${chunkId}`).
   */
  keywordIndex?: KeywordIndex;
}

/**
 * Convenience class that wires embedder, vector store, chunker,
 * and optional reranker into a single ingestion + retrieval pipeline.
 *
 * Implements the Retriever interface so it can be passed directly
 * to createVectorRetrievalTool() or used as an agent retriever.
 */
export class RagPipeline implements Retriever {
  private readonly embedder: Embedder;
  private readonly vectorStore: VectorStoreCore;
  private readonly chunker: Chunker;
  private readonly indexName: string;
  private readonly reranker?: Reranker;
  private readonly defaultTopK: number;
  private readonly metric: 'cosine' | 'euclidean' | 'dotproduct';
  private readonly batchSize: number;
  private readonly manifest?: IngestManifest;
  private readonly keywordIndex?: KeywordIndex;
  private lockChecked = false;
  private lockedDimension?: number;

  constructor(options: RagPipelineOptions) {
    this.embedder = options.embedder;
    this.vectorStore = options.vectorStore;
    this.chunker = options.chunker;
    this.indexName = options.indexName;
    this.reranker = options.reranker;
    this.defaultTopK = options.topK ?? 10;
    this.metric = options.metric ?? 'cosine';
    this.batchSize = options.batchSize ?? 100;
    this.manifest = options.manifest;
    this.keywordIndex = options.keywordIndex;
  }

  /**
   * Ensure the vector index exists, creating it if necessary.
   * Requires at least one embed() call to determine dimension.
   *
   * On edge stores that only implement `VectorStoreCore` (indexes
   * provisioned out-of-band), this is a no-op — the store's own
   * `listIndexes()` is still consulted so a genuinely missing index
   * surfaces later at query time via the backend's own error.
   */
  async ensureIndex(): Promise<void> {
    const indexes = await this.vectorStore.listIndexes();
    if (indexes.includes(this.indexName)) return;

    if (!hasIndexAdmin(this.vectorStore)) {
      // Edge-only adapter; indexes are provisioned out-of-band.
      return;
    }

    let dimension = this.embedder.dimension;
    if (!dimension) {
      const probe = await this.embedder.embed('dimension probe');
      dimension = probe.length;
    }

    await this.vectorStore.createIndex({
      indexName: this.indexName,
      dimension,
      metric: this.metric,
    });
  }

  /**
   * Throw if the manifest records a different embedder than this
   * pipeline's. Two models with the SAME dimension still produce
   * incompatible vector spaces — without this check the mismatch is
   * silent and every query degrades to near-random.
   */
  private assertEmbedderLock(data: IngestManifestData): void {
    const locked = data.embedder;
    if (!locked) return;
    const mismatchedId =
      locked.id !== undefined &&
      this.embedder.id !== undefined &&
      locked.id !== this.embedder.id;
    const mismatchedDim =
      locked.dimension !== undefined &&
      this.embedder.dimension !== undefined &&
      locked.dimension !== this.embedder.dimension;
    if (mismatchedId || mismatchedDim) {
      throw new Error(
        `RagPipeline: index '${this.indexName}' was built with embedder ` +
          `'${locked.id ?? 'unknown'}' (dimension ${locked.dimension ?? '?'}) but this ` +
          `pipeline uses '${this.embedder.id ?? 'unknown'}' (dimension ` +
          `${this.embedder.dimension ?? '?'}). Mixing embedding models silently corrupts ` +
          `relevance. Either restore the original embedder, or re-index: clear the ` +
          `index and its manifest entry, then ingest with the new model.`,
      );
    }
  }

  private async loadManifestData(): Promise<IngestManifestData | undefined> {
    if (!this.manifest) return undefined;
    return this.manifest.load(this.indexName);
  }

  /**
   * Ingest documents: chunk, embed, and store in the vector store.
   *
   * With a manifest configured, documents whose content hash is unchanged
   * since the last ingest are skipped entirely (zero embed calls), and
   * stale chunks of changed documents are removed from the vector store
   * (admin stores) and the keyword index.
   */
  async ingest(documents: Document[]): Promise<void> {
    await this.ensureIndex();

    const data = await this.loadManifestData();
    if (data) {
      this.assertEmbedderLock(data);
      this.lockedDimension = data.embedder?.dimension;
      this.lockChecked = true;
    }
    const docRecords: IngestManifestData['docs'] = { ...(data?.docs ?? {}) };
    const skipped: Document[] = [];

    for (const doc of documents) {
      const hash = this.manifest ? await sha256Hex(doc.text) : '';
      const previous = this.manifest ? docRecords[doc.id] : undefined;
      if (previous && previous.hash === hash) {
        skipped.push(doc);
        continue;
      }

      const chunks = this.chunker.chunk(doc.text);
      if (chunks.length === 0) continue;

      const texts = chunks.map(c => c.text);

      // Batch embedding to respect provider limits
      const allEmbeddings: (readonly number[])[] = [];
      for (let i = 0; i < texts.length; i += this.batchSize) {
        const batch = texts.slice(i, i + this.batchSize);
        const embeddings = await this.embedder.embedMany(batch);
        allEmbeddings.push(...embeddings);
      }

      const entries = chunks.map((chunk, i) => ({
        id: `${doc.id}:${chunk.id}`,
        vector: allEmbeddings[i],
        metadata: {
          ...(chunk.meta ?? {}),
          ...(doc.metadata ?? {}),
          sourceDocId: doc.id,
          chunkId: chunk.id,
        },
        document: chunk.text,
      }));

      await this.vectorStore.upsert(this.indexName, entries);

      const newIds = new Set(entries.map(e => e.id));
      if (previous) {
        const stale = previous.chunkIds.filter(id => !newIds.has(id));
        if (stale.length > 0) {
          if (hasIndexAdmin(this.vectorStore)) {
            await this.vectorStore.deleteVectors(this.indexName, { ids: stale });
          }
          for (const id of stale) this.keywordIndex?.remove(id);
        }
      }
      this.keywordIndex?.add(entries.map(e => ({ id: e.id, text: e.document })));

      if (this.manifest) {
        docRecords[doc.id] = { hash, chunkIds: [...newIds] };
      }
    }

    // Restart recovery for a non-persistent keyword index: manifest-skip
    // means skipped docs are never re-added, so after a process restart an
    // in-memory BM25Index would come back empty and hybrid retrieval would
    // silently degrade to vector-only. Re-seed by chunking alone — zero
    // embed calls. A persistent index (Fts5KeywordIndex) is non-empty here
    // and skips this entirely.
    if (this.keywordIndex && this.keywordIndex.size === 0 && skipped.length > 0) {
      for (const doc of skipped) {
        const chunks = this.chunker.chunk(doc.text);
        this.keywordIndex.add(
          chunks.map(c => ({ id: `${doc.id}:${c.id}`, text: c.text })),
        );
      }
    }

    if (this.manifest) {
      // A skip-only ingest may not have embedded anything, leaving
      // embedder.dimension undefined — preserve the recorded identity
      // rather than erasing it.
      await this.manifest.save(this.indexName, {
        embedder: {
          id: this.embedder.id ?? data?.embedder?.id,
          dimension: this.embedder.dimension ?? data?.embedder?.dimension,
        },
        docs: docRecords,
      });
    }
  }

  /**
   * Retrieve relevant chunks for a query.
   * Implements the Retriever interface.
   */
  async retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<RetrievalResult[]> {
    if (this.manifest && !this.lockChecked) {
      const data = await this.loadManifestData();
      if (data) {
        this.assertEmbedderLock(data);
        this.lockedDimension = data.embedder?.dimension;
      }
      this.lockChecked = true;
    }

    const topK = options?.topK ?? this.defaultTopK;
    // Use pre-computed query embedding when available to avoid double-embed cost
    const queryVector = options?.queryEmbedding ?? await this.embedder.embed(query);
    if (this.lockedDimension !== undefined && queryVector.length !== this.lockedDimension) {
      throw new Error(
        `RagPipeline: index '${this.indexName}' stores ${this.lockedDimension}-dimensional ` +
          `vectors but the query embedding has ${queryVector.length} dimensions — the ` +
          `embedding model differs from the one that built the index. Restore the ` +
          `original embedder or re-index with the new model.`,
      );
    }
    const includeVectors = options?.includeEmbeddings ?? false;

    // Fetch more than topK if reranking, to give the reranker a wider pool
    const fetchK = this.reranker ? topK * 3 : topK;

    const results = await this.vectorStore.query(this.indexName, {
      queryVector,
      topK: fetchK,
      filter: options?.filter,
      includeDocuments: true,
      includeVectors,
    });

    let mapped: RetrievalResult[] = results.map(r => ({
      id: r.id,
      text: r.document ?? '',
      score: r.score,
      relevanceScore: r.score,
      snippet: r.document ? r.document.slice(0, 240) : undefined,
      metadata: r.metadata,
      sourceId: typeof r.metadata?.sourceDocId === 'string' ? r.metadata.sourceDocId : this.indexName,
      embedding: r.vector,
    }));

    if (this.reranker) {
      mapped = await this.reranker.rerank(query, mapped, { topK });
    }

    return mapped.slice(0, topK);
  }
}
