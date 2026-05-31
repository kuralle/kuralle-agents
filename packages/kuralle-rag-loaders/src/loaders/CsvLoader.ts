import { readFile } from 'node:fs/promises';
import type { DocumentLoader, Document } from '@kuralle-agents/rag';
import Papa from 'papaparse';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CsvLoaderOptions {
  /**
   * Path to the CSV file on the local filesystem.
   * Mutually exclusive with `content`.
   */
  filePath?: string;
  /**
   * Raw CSV string. Use when the content is already in memory.
   * Mutually exclusive with `filePath`.
   */
  content?: string;
  /**
   * Column name whose values become the document text.
   * When not set, all columns are concatenated as "key: value" pairs.
   */
  textColumn?: string;
  /**
   * Column name to use as the document ID. When not set, a sequential
   * ID based on row index is generated.
   */
  idColumn?: string;
  /**
   * Columns to include in document metadata. When not set, all columns
   * except the text column are included.
   */
  metadataColumns?: string[];
  /**
   * Document metadata to attach to all loaded documents.
   */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CsvLoader
// ---------------------------------------------------------------------------

/**
 * Loads a CSV file and converts each row into a Document.
 *
 * Requires `papaparse` as a peer dependency. This loader is intended
 * for ingestion-time use only.
 */
export class CsvLoader implements DocumentLoader {
  private readonly filePath?: string;
  private readonly content?: string;
  private readonly textColumn?: string;
  private readonly idColumn?: string;
  private readonly metadataColumns?: string[];
  private readonly metadata: Record<string, unknown>;

  constructor(options: CsvLoaderOptions) {
    if (!options.filePath && !options.content) {
      throw new Error('CsvLoader: either filePath or content is required.');
    }
    this.filePath = options.filePath;
    this.content = options.content;
    this.textColumn = options.textColumn;
    this.idColumn = options.idColumn;
    this.metadataColumns = options.metadataColumns;
    this.metadata = options.metadata ?? {};
  }

  async load(): Promise<Document[]> {
    const csvText = this.content ?? await readFile(this.filePath!, 'utf-8');

    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    if (parsed.errors.length > 0) {
      const first = parsed.errors[0];
      throw new Error(
        `CsvLoader: Parse error at row ${first.row}: ${first.message}`,
      );
    }

    const source = this.filePath ?? 'csv-content';

    return parsed.data.map((row, index) => {
      const id = this.idColumn && row[this.idColumn]
        ? `${source}:${row[this.idColumn]}`
        : `${source}:row-${index}`;

      let text: string;
      if (this.textColumn) {
        text = row[this.textColumn] ?? '';
      } else {
        // Concatenate all columns as "key: value"
        text = Object.entries(row)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n');
      }

      // Build metadata from remaining columns
      const rowMeta: Record<string, unknown> = {};
      const metaCols = this.metadataColumns ?? Object.keys(row);
      for (const col of metaCols) {
        if (col !== this.textColumn && row[col] !== undefined) {
          rowMeta[col] = row[col];
        }
      }

      return {
        id,
        text,
        metadata: {
          ...this.metadata,
          ...rowMeta,
          source,
          contentType: 'text/csv',
          rowIndex: index,
        },
      };
    });
  }
}
