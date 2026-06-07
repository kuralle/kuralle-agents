import { describe, expect, it } from 'bun:test';
import { createFsTool } from '@kuralle-agents/core';
import { KnowledgeFs } from '../src/fs/KnowledgeFs.js';
import { KB_INDEX, seedKnowledgeStore } from './knowledgefs-fixture.js';

describe('test:kfs-grep', () => {
  it('returns hits via coarse search hook and fine regex pass', async () => {
    const store = await seedKnowledgeStore([
      {
        path: '/policies/refund.md',
        chunks: ['Refunds are available within 30 days.\n'],
      },
      {
        path: '/policies/shipping.md',
        chunks: ['Shipping takes 5-7 business days.\n'],
      },
      {
        path: '/help/contact.md',
        chunks: ['Email support@example.com for refunds help.\n'],
      },
    ]);

    const fs = await KnowledgeFs.open({ store, indexName: KB_INDEX });
    const tool = createFsTool({ fs, readOnly: true });
    const result = await tool.execute!({
      op: 'grep',
      pattern: 'refund',
      path: '/',
      flags: 'i',
    });

    expect(result).toMatchObject({ op: 'grep', ok: true, pattern: 'refund' });
    const hits = (result as { hits: { path: string; text: string }[] }).hits;
    const paths = hits.map((h) => h.path);
    expect(paths).toContain('/policies/refund.md');
    expect(paths).toContain('/help/contact.md');
    expect(paths).not.toContain('/policies/shipping.md');
  });
});
