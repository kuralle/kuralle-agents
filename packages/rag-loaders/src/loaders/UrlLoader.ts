import type { DocumentLoader, Document } from '@kuralle-agents/rag';
import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface UrlLoaderOptions {
  /** The URL to fetch and extract text from. */
  url: string;
  /**
   * CSS selector to scope text extraction. When set, only text within
   * matching elements is extracted. Default: extracts from `<body>`.
   */
  selector?: string;
  /**
   * Custom fetch options (headers, timeout, etc.).
   */
  fetchOptions?: RequestInit;
  /**
   * Document metadata to attach to all loaded documents.
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// UrlLoader
// ---------------------------------------------------------------------------

/**
 * Loads a web page and extracts its text content using Cheerio.
 *
 * Requires `cheerio` as a peer dependency. Uses `fetch()` to retrieve
 * the page, so it works in any runtime that provides a global `fetch`.
 *
 * This loader is intended for ingestion-time use only.
 */
export class UrlLoader implements DocumentLoader {
  private readonly url: string;
  private readonly selector: string;
  private readonly fetchOptions?: RequestInit;
  private readonly metadata: Record<string, unknown>;

  constructor(options: UrlLoaderOptions) {
    this.url = options.url;
    this.selector = options.selector ?? 'body';
    this.fetchOptions = options.fetchOptions;
    this.metadata = options.metadata ?? {};
  }

  async load(): Promise<Document[]> {
    const response = await fetch(this.url, this.fetchOptions);

    if (!response.ok) {
      throw new Error(
        `UrlLoader: Failed to fetch ${this.url} (${response.status} ${response.statusText})`,
      );
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove script and style elements before extracting text
    $('script, style, noscript').remove();

    const text = $(this.selector)
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    const title = $('title').text().trim() || undefined;

    return [
      {
        id: this.url,
        text,
        metadata: {
          ...this.metadata,
          source: this.url,
          contentType: 'text/html',
          title,
        },
      },
    ];
  }
}
