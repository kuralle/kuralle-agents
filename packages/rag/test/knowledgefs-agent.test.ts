import { describe, expect, it } from 'bun:test';
import { createFsTool, defineAgent } from '@kuralle-agents/core';
import { KnowledgeFs } from '../src/fs/KnowledgeFs.js';
import { KB_INDEX, seedKnowledgeStore } from './knowledgefs-fixture.js';

describe('test:kfs-agent', () => {
  it('answers a multi-page question via grep then cat', async () => {
    const store = await seedKnowledgeStore([
      {
        path: '/policies/returns.md',
        chunks: [
          '# Returns Policy\n\n',
          'Customers may return items within 30 days of delivery.\n',
        ],
      },
      {
        path: '/support/contact.md',
        chunks: [
          '# Contact\n\n',
          'For return questions email returns@acme.example.\n',
        ],
      },
    ]);

    const workspace = await KnowledgeFs.open({ store, indexName: KB_INDEX });
    const agent = defineAgent({
      id: 'support',
      instructions: 'Answer from the knowledge base using workspace grep and cat.',
      workspace,
    });

    expect(agent.workspace).toBe(workspace);

    const tool = createFsTool({ fs: workspace, readOnly: true });

    const grep = await tool.execute!({
      op: 'grep',
      pattern: '30 days|returns@',
      path: '/',
    });
    const hits = (grep as { hits: { path: string }[] }).hits;
    const paths = [...new Set(hits.map((h) => h.path))];
    expect(paths).toContain('/policies/returns.md');
    expect(paths).toContain('/support/contact.md');

    const pages = await Promise.all(
      paths.map(async (path) => ({
        path,
        content: (await tool.execute!({ op: 'cat', path })) as { content: string },
      })),
    );

    const combined = pages.map((p) => p.content.content).join('\n');
    expect(combined).toContain('30 days');
    expect(combined).toContain('returns@acme.example');
  });
});
