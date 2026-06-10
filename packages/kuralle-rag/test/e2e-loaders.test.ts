/**
 * E2E Loader Test — exercises document loaders end-to-end.
 *
 * Tests MarkdownLoader and CsvLoader (which don't need network/files).
 * PdfLoader and UrlLoader require actual files/network so they're
 * tested with mock data where possible.
 *
 * No API keys needed.
 */

import { describe, test, expect } from 'bun:test';
import { MarkdownLoader, CsvLoader } from '../../kuralle-rag-loaders/src/index.js';

const MARKDOWN_CONTENT = `# Company Handbook

## Working Hours
Standard hours are 9am to 5pm Monday through Friday.
Flexible working is available with manager approval.

## Leave Policy
Employees get 20 days paid leave per year.
Sick leave is 10 days per year.

## Remote Work
Remote work is permitted 3 days per week.
All employees must be in office on Tuesday and Thursday.
`;

const CSV_CONTENT = `name,role,department,salary
Alice,Engineer,Engineering,120000
Bob,Designer,Design,95000
Charlie,Manager,Engineering,150000
Diana,Analyst,Data,110000
`;

describe('Document Loaders E2E', () => {
  test('MarkdownLoader: loads full document', async () => {
    const loader = new MarkdownLoader({ content: MARKDOWN_CONTENT });
    const docs = await loader.load();

    expect(docs.length).toBe(1);
    expect(docs[0].text).toBe(MARKDOWN_CONTENT);
    expect(docs[0].metadata?.contentType).toBe('text/markdown');
    console.log(`  Loaded 1 document, ${docs[0].text.length} chars`);
  });

  test('MarkdownLoader: splits by heading', async () => {
    const loader = new MarkdownLoader({
      content: MARKDOWN_CONTENT,
      splitByHeading: true,
      splitLevel: 2,
    });
    const docs = await loader.load();

    // 4 sections: preamble (# heading) + 3 ## headings
    expect(docs.length).toBeGreaterThanOrEqual(3);
    for (const doc of docs) {
      expect(doc.text.length).toBeGreaterThan(0);
    }
    console.log(`  Split into ${docs.length} sections: ${docs.map(d => d.metadata?.section ?? 'preamble').join(', ')}`);
  });

  test('CsvLoader: loads rows as documents', async () => {
    const loader = new CsvLoader({
      content: CSV_CONTENT,
      textColumn: 'name',
      idColumn: 'name',
    });
    const docs = await loader.load();

    expect(docs.length).toBe(4);
    expect(docs[0].text).toBe('Alice');
    expect(docs[0].metadata?.role).toBe('Engineer');
    expect(docs[0].metadata?.department).toBe('Engineering');
    console.log(`  Loaded ${docs.length} rows from CSV`);
  });

  test('CsvLoader: concatenates all columns when no textColumn', async () => {
    const loader = new CsvLoader({ content: CSV_CONTENT });
    const docs = await loader.load();

    expect(docs.length).toBe(4);
    // All columns should be concatenated
    expect(docs[0].text).toContain('name: Alice');
    expect(docs[0].text).toContain('role: Engineer');
    console.log(`  Full-row text: "${docs[0].text.slice(0, 60)}..."`);
  });

  test('MarkdownLoader + FusionRetriever: full ingest-to-retrieve', async () => {
    // This test chains: loader → chunker → ingest → search
    const { InMemoryVectorStore, RagPipeline, BM25Index, FusionRetriever, createTokenChunker } = await import('../src/index.js');

    // Mock embedder (reuse pattern from pipeline test)
    const dimension = 32;
    const embedder = {
      dimension,
      async embed(text: string) {
        const vec = new Float64Array(dimension);
        const tokens = text.toLowerCase().split(/\s+/);
        for (const t of tokens) {
          let hash = 0;
          for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) % dimension;
          vec[hash] += 1;
        }
        let mag = 0;
        for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
        mag = Math.sqrt(mag);
        if (mag > 0) for (let i = 0; i < vec.length; i++) vec[i] /= mag;
        return Array.from(vec) as readonly number[];
      },
      async embedMany(texts: string[]) {
        return Promise.all(texts.map(t => this.embed(t)));
      },
    };

    // 1. Load markdown
    const loader = new MarkdownLoader({ content: MARKDOWN_CONTENT, splitByHeading: true, splitLevel: 2 });
    const docs = await loader.load();
    expect(docs.length).toBeGreaterThanOrEqual(3);

    // 2. Ingest
    const vectorStore = new InMemoryVectorStore();
    const chunker = createTokenChunker({ defaults: { maxTokens: 200 } });
    const pipeline = new RagPipeline({ embedder, vectorStore, chunker, indexName: 'handbook' });
    await pipeline.ingest(docs);

    const stats = await vectorStore.describeIndex?.('handbook');
    console.log(`  Ingested ${stats?.count} vectors from ${docs.length} markdown sections`);

    // 3. Build BM25 index from the same chunks
    const bm25 = new BM25Index();
    for (const doc of docs) {
      const chunks = chunker.chunk(doc.text);
      bm25.add(chunks.map(c => ({ id: `${doc.id}:${c.id}`, text: c.text })));
    }

    // 4. FusionRetriever
    const retriever = new FusionRetriever({ keywordIndex: bm25, vectorStore, embedder, indexName: 'handbook', topK: 2 });
    const results = await retriever.retrieve('How many days of leave?');
    expect(results.length).toBeGreaterThan(0);
    // The top result should mention leave
    const topText = results[0].text.toLowerCase();
    expect(topText).toContain('leave');
    console.log(`  Search "How many days of leave?": ${results.length} results`);
    console.log(`  Top result: "${results[0].text.slice(0, 80)}..."`);
  });
});
