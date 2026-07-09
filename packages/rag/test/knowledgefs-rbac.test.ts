import { describe, expect, it } from 'bun:test';
import { KnowledgeFs } from '../src/fs/KnowledgeFs.js';
import { KB_INDEX, seedKnowledgeStore } from './knowledgefs-fixture.js';

describe('test:kfs-rbac', () => {
  it('pruned slug is absent from ls and cat throws ENOENT', async () => {
    const store = await seedKnowledgeStore([
      { path: '/public/faq.md', chunks: ['public faq'] },
      { path: '/internal/billing.md', chunks: ['secret billing'] },
    ]);

    const fs = await KnowledgeFs.open({
      store,
      indexName: KB_INDEX,
      accessFilter: {
        allowSlug: (slug) => !slug.startsWith('/internal'),
      },
    });

    expect(await fs.exists('/internal/billing.md')).toBe(false);
    expect(await fs.exists('/public/faq.md')).toBe(true);

    const entries = await fs.readdir('/public');
    expect(entries).toContain('faq.md');
    expect(entries).not.toContain('../internal');

    await expect(fs.readFile('/internal/billing.md')).rejects.toThrow(/ENOENT/);

    const traversal = fs.resolvePath('/public', '../internal/billing.md');
    expect(traversal).toBe('/internal/billing.md');
    await expect(fs.readFile(traversal)).rejects.toThrow(/ENOENT/);
  });

  it('vectorFilter prunes entries at init', async () => {
    const store = await seedKnowledgeStore([
      { path: '/tier/free.md', chunks: ['free tier'] },
    ]);

    await store.upsert(KB_INDEX, [
      {
        id: '/tier/enterprise.md#0',
        vector: [0, 0, 0, 0],
        metadata: {
          page: '/tier/enterprise.md',
          chunk_index: 0,
          tier: 'enterprise',
        },
        document: 'enterprise tier',
      },
    ]);

    const fs = await KnowledgeFs.open({
      store,
      indexName: KB_INDEX,
      accessFilter: {
        vectorFilter: { tier: { $ne: 'enterprise' } },
      },
    });

    expect(await fs.exists('/tier/free.md')).toBe(true);
    expect(await fs.exists('/tier/enterprise.md')).toBe(false);
  });
});
