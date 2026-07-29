import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { ContentWorkspace } from '../src/workspace.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kuralle-content-agent-'));
  roots.push(root);
  const fs = nodeFileSystem(root);
  await fs.mkdir('/sources', { recursive: true });
  await fs.mkdir('/skills/blog-style/references', { recursive: true });
  await fs.writeFile('/sources/brief.md', '# Brief\n\nThe launch is on Friday.');
  await fs.writeFile('/skills/blog-style/references/banned-words.json', '["leverage", "game-changing"]');
  return { fs, content: new ContentWorkspace(fs) };
}

describe('ContentWorkspace', () => {
  it('saves grounded Markdown and rejects an unreviewed overwrite', async () => {
    const { fs, content } = await fixture();
    const saved = await content.saveDraft({
      title: 'A grounded launch note',
      surface: 'blog',
      slug: 'launch-note',
      body: '# A grounded launch note\n\nThe launch is on Friday.',
      sourcePaths: ['/sources/brief.md'],
    });

    expect(saved.path).toBe('/drafts/blog/launch-note.md');
    expect(saved.revision).toHaveLength(64);
    expect(await fs.readFile(saved.path)).toContain('"sources": [');

    await expect(content.saveDraft({
      title: 'Changed title',
      surface: 'blog',
      slug: 'launch-note',
      body: '# Changed title\n\nThe launch remains on Friday.',
      sourcePaths: ['/sources/brief.md'],
    })).rejects.toThrow(/EEXIST/);
  });

  it('fails closed on style-resource errors and banned terms', async () => {
    const { fs, content } = await fixture();
    expect(await content.lint('blog', 'We can leverage this.')).toEqual({
      ok: false,
      violations: [{ term: 'leverage', message: 'Avoid "leverage" per the blog style guide.' }],
    });

    await fs.writeFile('/skills/blog-style/references/banned-words.json', '{bad json');
    await expect(content.lint('blog', 'Clean text')).rejects.toThrow();
  });

  it('publishes only the exact current revision and never overwrites', async () => {
    const { content } = await fixture();
    const saved = await content.saveDraft({
      title: 'A grounded launch note',
      surface: 'blog',
      slug: 'launch-note',
      body: '# A grounded launch note\n\nThe launch is on Friday.',
      sourcePaths: ['/sources/brief.md'],
    });

    await expect(content.publishDraft('blog', 'launch-note', '0'.repeat(64))).rejects.toThrow(/ESTALE/);
    const published = await content.publishDraft('blog', 'launch-note', saved.revision);
    expect(published.metadata.status).toBe('published');
    expect(published.path).toBe('/published/blog/launch-note.md');
    await expect(content.publishDraft('blog', 'launch-note', saved.revision)).rejects.toThrow(/EEXIST/);
  });

  it('requires local Markdown sources below /sources', async () => {
    const { content } = await fixture();
    await expect(content.saveDraft({
      title: 'An unsupported draft',
      surface: 'blog',
      slug: 'unsupported',
      body: '# Unsupported\n\nThis body has no acceptable source.',
      sourcePaths: ['/preferences/writer.md'],
    })).rejects.toThrow(/Sources must be Markdown below \/sources/);
  });
});
