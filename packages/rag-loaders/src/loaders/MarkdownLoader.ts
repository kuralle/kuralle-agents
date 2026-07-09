import { readFile } from 'node:fs/promises';
import type { DocumentLoader, Document } from '@kuralle-agents/rag';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MarkdownLoaderOptions {
  /**
   * Path to the Markdown file on the local filesystem.
   * Mutually exclusive with `content`.
   */
  filePath?: string;
  /**
   * Raw Markdown string. Use when the content is already in memory.
   * Mutually exclusive with `filePath`.
   */
  content?: string;
  /**
   * When true, splits the document by top-level headings (## or #)
   * into separate documents. Each heading becomes a separate document
   * with the heading text as metadata. Default: false.
   */
  splitByHeading?: boolean;
  /**
   * The heading level to split on when `splitByHeading` is true.
   * Default: 2 (splits on `##` headings).
   */
  splitLevel?: number;
  /**
   * Document metadata to attach to all loaded documents.
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MarkdownLoader
// ---------------------------------------------------------------------------

/**
 * Loads Markdown files, optionally splitting by heading into multiple
 * documents. Zero external dependencies — uses regex-based parsing.
 *
 * This loader is intended for ingestion-time use only.
 */
export class MarkdownLoader implements DocumentLoader {
  private readonly filePath?: string;
  private readonly content?: string;
  private readonly splitByHeading: boolean;
  private readonly splitLevel: number;
  private readonly metadata: Record<string, unknown>;

  constructor(options: MarkdownLoaderOptions) {
    if (!options.filePath && !options.content) {
      throw new Error('MarkdownLoader: either filePath or content is required.');
    }
    this.filePath = options.filePath;
    this.content = options.content;
    this.splitByHeading = options.splitByHeading ?? false;
    this.splitLevel = options.splitLevel ?? 2;
    this.metadata = options.metadata ?? {};
  }

  async load(): Promise<Document[]> {
    const text = this.content ?? await readFile(this.filePath!, 'utf-8');
    const source = this.filePath ?? 'markdown-content';

    if (!this.splitByHeading) {
      return [
        {
          id: source,
          text,
          metadata: {
            ...this.metadata,
            source,
            contentType: 'text/markdown',
          },
        },
      ];
    }

    return this.splitOnHeading(text, source);
  }

  private splitOnHeading(text: string, source: string): Document[] {
    const hashes = '#'.repeat(this.splitLevel);
    // Match headings at the configured level (e.g., ## for level 2)
    const pattern = new RegExp(`^${hashes}\\s+(.+)$`, 'gm');

    const sections: Array<{ heading: string; start: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      sections.push({
        heading: match[1].trim(),
        start: match.index,
      });
    }

    if (sections.length === 0) {
      // No headings found at the specified level — return as single doc
      return [
        {
          id: source,
          text,
          metadata: {
            ...this.metadata,
            source,
            contentType: 'text/markdown',
          },
        },
      ];
    }

    const documents: Document[] = [];

    // Content before the first heading (preamble)
    if (sections[0].start > 0) {
      const preamble = text.slice(0, sections[0].start).trim();
      if (preamble) {
        documents.push({
          id: `${source}:preamble`,
          text: preamble,
          metadata: {
            ...this.metadata,
            source,
            contentType: 'text/markdown',
            section: 'preamble',
          },
        });
      }
    }

    // Each heading section
    for (let i = 0; i < sections.length; i++) {
      const start = sections[i].start;
      const end = i + 1 < sections.length ? sections[i + 1].start : text.length;
      const sectionText = text.slice(start, end).trim();

      if (!sectionText) continue;

      const slug = sections[i].heading
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');

      documents.push({
        id: `${source}:${slug}`,
        text: sectionText,
        metadata: {
          ...this.metadata,
          source,
          contentType: 'text/markdown',
          section: sections[i].heading,
        },
      });
    }

    return documents;
  }
}
