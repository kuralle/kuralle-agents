/**
 * E2E Test — Task-Type-Aware Embedding with Gemini
 *
 * Tests that Gemini RETRIEVAL_QUERY vs RETRIEVAL_DOCUMENT task types
 * produce different (and more appropriate) embeddings for their use cases.
 *
 * Requires: GOOGLE_GENERATIVE_AI_API_KEY environment variable.
 * Skips gracefully if not available.
 *
 * Verifies:
 * 1. providerOptions are passed through to the AI SDK
 * 2. RETRIEVAL_QUERY and RETRIEVAL_DOCUMENT produce different embeddings
 * 3. Query-to-query similarity is higher than query-to-document similarity
 *    (confirming asymmetric embedding behavior)
 * 4. Dual-embedder pattern works (separate instances for query vs document)
 */

import { describe, test, expect } from 'bun:test';
import { AiSdkEmbedder } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helper: cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

// ---------------------------------------------------------------------------
// Skip if no API key
// ---------------------------------------------------------------------------

const API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const describeIf = API_KEY ? describe : describe.skip;

describeIf('Task-Type-Aware Embedding (Gemini)', () => {
  // Lazy import to avoid errors when @ai-sdk/google is not available
  let google: Awaited<typeof import('@ai-sdk/google')>['google'];

  test('setup: import @ai-sdk/google', async () => {
    const mod = await import('@ai-sdk/google');
    google = mod.google;
    expect(google).toBeDefined();
  });

  test('providerOptions are passed through (RETRIEVAL_QUERY produces valid embedding)', async () => {
    const queryEmbedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } },
    });

    const embedding = await queryEmbedder.embed('What is the return policy?');
    expect(embedding.length).toBeGreaterThan(0);
    expect(queryEmbedder.dimension).toBe(embedding.length);
  });

  test('providerOptions are passed through (RETRIEVAL_DOCUMENT produces valid embedding)', async () => {
    const docEmbedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } },
    });

    const embedding = await docEmbedder.embed(
      'Our return policy allows returns within 30 days of purchase. Items must be in original packaging.',
    );
    expect(embedding.length).toBeGreaterThan(0);
  });

  test('RETRIEVAL_QUERY and RETRIEVAL_DOCUMENT produce different embeddings for same text', async () => {
    const sameText = 'Acme return policy allows 30-day returns';

    const queryEmbedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } },
    });

    const docEmbedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } },
    });

    const queryEmb = await queryEmbedder.embed(sameText);
    const docEmb = await docEmbedder.embed(sameText);

    // Same text, different task types → different embeddings
    const similarity = cosineSimilarity(queryEmb, docEmb);
    // Same text, different task types — related but not identical.
    expect(similarity).toBeLessThan(0.999);
    expect(similarity).toBeGreaterThan(0.35);
  });

  test('query-to-query similarity is higher than query-to-document similarity (asymmetric)', async () => {
    const queryEmbedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } },
    });

    const docEmbedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } },
    });

    // Two similar queries
    const q1 = await queryEmbedder.embed('What is the return policy?');
    const q2 = await queryEmbedder.embed('How can I return a product?');

    // Document embedding for the return policy
    const doc = await docEmbedder.embed(
      'Our return policy allows returns within 30 days of purchase. Items must be in original packaging and unused condition.',
    );

    const queryToQuery = cosineSimilarity(q1, q2);
    const queryToDoc = cosineSimilarity(q1, doc);

    // Query-to-query should beat query-to-document by a margin (API variance-safe).
    expect(queryToQuery - queryToDoc).toBeGreaterThan(0.02);
  });

  test('embedMany works with providerOptions', async () => {
    const docEmbedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } },
    });

    const embeddings = await docEmbedder.embedMany([
      'Return policy document text.',
      'Shipping policy document text.',
      'Warranty information document text.',
    ]);

    expect(embeddings.length).toBe(3);
    expect(embeddings[0].length).toBeGreaterThan(0);
    // All same dimension
    expect(embeddings[1].length).toBe(embeddings[0].length);
    expect(embeddings[2].length).toBe(embeddings[0].length);
  });

  test('backward compatibility: no providerOptions still works', async () => {
    const embedder = new AiSdkEmbedder({
      model: google.embedding('gemini-embedding-001'),
      // No providerOptions — backward compatible
    });

    const embedding = await embedder.embed('test query');
    expect(embedding.length).toBeGreaterThan(0);
  });
});
