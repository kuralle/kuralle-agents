import { InMemoryVectorStore } from '../src/vectorStores/InMemoryVectorStore.js';
import {
  CHUNK_INDEX_META_KEY,
  PAGE_META_KEY,
  PATH_TREE_MANIFEST_ID,
} from '../src/fs/path-tree.js';

const DIM = 4;
const ZERO = [0, 0, 0, 0] as const;
export const KB_INDEX = 'kb';

export interface SeedPage {
  path: string;
  chunks: string[];
}

export async function seedKnowledgeStore(
  pages: SeedPage[],
  opts?: { manifest?: boolean; extra?: Array<{ id: string; page: string; chunkIndex: number; text: string }> },
): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore();
  await store.createIndex({ indexName: KB_INDEX, dimension: DIM, metric: 'cosine' });

  const entries = [];
  for (const page of pages) {
    for (let i = 0; i < page.chunks.length; i++) {
      entries.push({
        id: `${page.path}#${i}`,
        vector: ZERO,
        metadata: {
          [PAGE_META_KEY]: page.path,
          [CHUNK_INDEX_META_KEY]: i,
        },
        document: page.chunks[i]!,
      });
    }
  }

  for (const extra of opts?.extra ?? []) {
    entries.push({
      id: extra.id,
      vector: ZERO,
      metadata: {
        [PAGE_META_KEY]: extra.page,
        [CHUNK_INDEX_META_KEY]: extra.chunkIndex,
      },
      document: extra.text,
    });
  }

  if (opts?.manifest) {
    const manifest: Record<string, { isPublic: boolean }> = {};
    for (const page of pages) {
      manifest[page.path] = { isPublic: true };
    }
    entries.push({
      id: PATH_TREE_MANIFEST_ID,
      vector: ZERO,
      metadata: { kind: 'manifest' },
      document: JSON.stringify(manifest),
    });
  }

  await store.upsert(KB_INDEX, entries);
  return store;
}
