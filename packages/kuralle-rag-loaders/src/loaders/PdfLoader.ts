import { readFile } from 'node:fs/promises';
import type { DocumentLoader, Document } from '@kuralle-agents/rag';
import pdfParse from 'pdf-parse';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PdfLoaderOptions {
  /**
   * Path to the PDF file on the local filesystem.
   * Mutually exclusive with `buffer`.
   */
  filePath?: string;
  /**
   * Raw PDF bytes. Use when the file is already in memory
   * (e.g., uploaded via an API). Mutually exclusive with `filePath`.
   */
  buffer?: Buffer;
  /**
   * Document metadata to attach to all loaded documents.
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PdfLoader
// ---------------------------------------------------------------------------

/**
 * Loads a PDF file and extracts its text content.
 *
 * Requires `pdf-parse` as a peer dependency. This loader is intended
 * for ingestion-time use only — it should never be imported in runtime
 * bundles that target edge/serverless environments.
 */
export class PdfLoader implements DocumentLoader {
  private readonly filePath?: string;
  private readonly buffer?: Buffer;
  private readonly metadata: Record<string, unknown>;

  constructor(options: PdfLoaderOptions) {
    if (!options.filePath && !options.buffer) {
      throw new Error('PdfLoader: either filePath or buffer is required.');
    }
    this.filePath = options.filePath;
    this.buffer = options.buffer;
    this.metadata = options.metadata ?? {};
  }

  async load(): Promise<Document[]> {
    const data = this.buffer ?? await readFile(this.filePath!);
    const parsed = await pdfParse(data);

    const id = this.filePath ?? `pdf-${Date.now()}`;

    return [
      {
        id,
        text: parsed.text,
        metadata: {
          ...this.metadata,
          source: this.filePath ?? 'buffer',
          contentType: 'application/pdf',
          pages: parsed.numpages,
        },
      },
    ];
  }
}
