import { createHash } from 'node:crypto';
import type { FileSystem } from '@kuralle-agents/core';

export const SURFACES = ['blog', 'linkedin', 'newsletter', 'release-notes', 'x'] as const;
export type Surface = (typeof SURFACES)[number];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_PATH = /^\/sources\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.md$/;
const META_OPEN = '<!-- kuralle-content-meta\n';
const META_CLOSE = '\n-->';

interface ContentMetadata {
  title: string;
  surface: Surface;
  slug: string;
  status: 'draft' | 'published';
  sources: string[];
  updatedAt: string;
  publishedAt?: string;
}

export interface DraftInput {
  title: string;
  surface: Surface;
  slug: string;
  body: string;
  sourcePaths: string[];
  expectedRevision?: string;
}

export interface StoredContent {
  path: string;
  revision: string;
  metadata: ContentMetadata;
  body: string;
}

export interface StyleLintResult {
  ok: boolean;
  violations: Array<{ term: string; message: string }>;
}

export class ContentWorkspace {
  constructor(private readonly fs: FileSystem) {}

  async getPreferences(): Promise<{ found: boolean; preferences: string; revision?: string }> {
    const path = '/preferences/writer.md';
    if (!(await this.fs.exists(path))) return { found: false, preferences: '' };
    const preferences = await this.fs.readFile(path);
    return { found: true, preferences, revision: revisionOf(preferences) };
  }

  async savePreferences(preferences: string, expectedRevision?: string) {
    if (preferences.length > 20_000) throw new Error('Writer preferences must be 20,000 characters or fewer.');
    const path = '/preferences/writer.md';
    await this.assertRevision(path, expectedRevision);
    await this.atomicWrite(path, preferences.trimEnd() + '\n');
    const stored = await this.fs.readFile(path);
    return { path, revision: revisionOf(stored) };
  }

  async lint(surface: Surface, text: string): Promise<StyleLintResult> {
    if (text.length === 0 || text.length > 100_000) {
      throw new Error('Draft text must contain between 1 and 100,000 characters.');
    }
    const path = `/skills/${surface}-style/references/banned-words.json`;
    const raw = await this.fs.readFile(path);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error(`Invalid banned-words resource: ${path}`);
    }
    const banned = [...new Set(parsed.map((item) => item.trim()).filter(Boolean))];
    const violations = banned
      .filter((term) => literalMatcher(term).test(text))
      .map((term) => ({ term, message: `Avoid "${term}" per the ${surface} style guide.` }));
    return { ok: violations.length === 0, violations };
  }

  async saveDraft(input: DraftInput): Promise<StoredContent> {
    assertSlug(input.slug);
    if (input.title.trim().length < 3 || input.title.length > 160) {
      throw new Error('Draft title must contain between 3 and 160 characters.');
    }
    if (input.body.trim().length < 20 || input.body.length > 100_000) {
      throw new Error('Draft body must contain between 20 and 100,000 characters.');
    }
    const sources = [...new Set(input.sourcePaths)];
    if (sources.length === 0) throw new Error('At least one local Markdown source is required.');
    for (const source of sources) {
      if (!SOURCE_PATH.test(source) || source.includes('..')) {
        throw new Error(`Invalid source path "${source}". Sources must be Markdown below /sources.`);
      }
      if (!(await this.fs.exists(source))) throw new Error(`Source file not found: ${source}`);
    }

    const lint = await this.lint(input.surface, input.body);
    if (!lint.ok) throw new Error(`Style lint failed: ${lint.violations.map((v) => v.term).join(', ')}`);

    const path = draftPath(input.surface, input.slug);
    await this.assertRevision(path, input.expectedRevision);
    const metadata: ContentMetadata = {
      title: input.title.trim(),
      surface: input.surface,
      slug: input.slug,
      status: 'draft',
      sources,
      updatedAt: new Date().toISOString(),
    };
    await this.atomicWrite(path, serialize(metadata, input.body));
    return this.readStored(path);
  }

  async publishDraft(surface: Surface, slug: string, expectedRevision: string): Promise<StoredContent> {
    assertSlug(slug);
    const sourcePath = draftPath(surface, slug);
    const draft = await this.readStored(sourcePath);
    if (draft.revision !== expectedRevision) {
      throw new Error(`ESTALE: draft changed; expected ${expectedRevision}, current ${draft.revision}`);
    }
    const lint = await this.lint(surface, draft.body);
    if (!lint.ok) throw new Error(`Style lint failed: ${lint.violations.map((v) => v.term).join(', ')}`);

    const publishedAt = new Date().toISOString();
    const metadata: ContentMetadata = {
      ...draft.metadata,
      status: 'published',
      updatedAt: publishedAt,
      publishedAt,
    };
    const path = `/published/${surface}/${slug}.md`;
    if (await this.fs.exists(path)) {
      throw new Error(`EEXIST: published content already exists at ${path}`);
    }
    await this.atomicWrite(path, serialize(metadata, draft.body));
    return this.readStored(path);
  }

  async getDraft(surface: Surface, slug: string): Promise<StoredContent> {
    assertSlug(slug);
    return this.readStored(draftPath(surface, slug));
  }

  async deleteDraft(surface: Surface, slug: string, expectedRevision: string) {
    assertSlug(slug);
    const path = draftPath(surface, slug);
    await this.assertRevision(path, expectedRevision, true);
    await this.fs.rm(path);
    return { deleted: true, path };
  }

  async readStored(path: string): Promise<StoredContent> {
    const raw = await this.fs.readFile(path);
    const parsed = parseStored(raw, path);
    return { path, revision: revisionOf(raw), ...parsed };
  }

  private async assertRevision(path: string, expected?: string, mustExist = false): Promise<void> {
    const exists = await this.fs.exists(path);
    if (!exists) {
      if (mustExist) throw new Error(`ENOENT: content not found at ${path}`);
      if (expected) throw new Error(`ESTALE: ${path} does not exist but a prior revision was supplied.`);
      return;
    }
    const current = revisionOf(await this.fs.readFile(path));
    if (!expected) throw new Error(`EEXIST: ${path} already exists; read it and pass expectedRevision ${current}.`);
    if (current !== expected) throw new Error(`ESTALE: expected ${expected}, current ${current}`);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    await this.fs.mkdir(parent, { recursive: true });
    const temp = `${path}.tmp-${crypto.randomUUID()}`;
    await this.fs.writeFile(temp, content);
    try {
      await this.fs.mv(temp, path);
    } catch (error) {
      await this.fs.rm(temp, { force: true });
      throw error;
    }
  }
}

function assertSlug(slug: string): void {
  if (!SLUG.test(slug) || slug.length > 80) {
    throw new Error('Slug must be 1-80 lowercase letters, numbers, and single hyphens.');
  }
}

function draftPath(surface: Surface, slug: string): string {
  return `/drafts/${surface}/${slug}.md`;
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function serialize(metadata: ContentMetadata, body: string): string {
  return `${META_OPEN}${JSON.stringify(metadata, null, 2)}${META_CLOSE}\n\n${body.trimEnd()}\n`;
}

function parseStored(raw: string, path: string): { metadata: ContentMetadata; body: string } {
  if (!raw.startsWith(META_OPEN)) throw new Error(`Invalid Kuralle content metadata: ${path}`);
  const end = raw.indexOf(META_CLOSE, META_OPEN.length);
  if (end < 0) throw new Error(`Invalid Kuralle content metadata: ${path}`);
  const metadata = JSON.parse(raw.slice(META_OPEN.length, end)) as ContentMetadata;
  if (!SURFACES.includes(metadata.surface) || !SLUG.test(metadata.slug)) {
    throw new Error(`Invalid Kuralle content metadata fields: ${path}`);
  }
  return { metadata, body: raw.slice(end + META_CLOSE.length).trimStart() };
}

function literalMatcher(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(term) ? '\\b' : '';
  const right = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, 'i');
}
