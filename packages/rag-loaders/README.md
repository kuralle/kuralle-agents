# @kuralle-agents/rag-loaders

Document loaders for Kuralle RAG pipelines: PDF, URL, CSV, and Markdown.

## Install

```bash
npm install @kuralle-agents/rag-loaders @kuralle-agents/rag
```

Peers: `@kuralle-agents/rag`. Optional per-loader: `pdf-parse` (PDF), `cheerio` (URL), `papaparse` (CSV).

## What it does

Four `DocumentLoader` implementations that return `Document[]` for indexing into any Kuralle vector store or RAG pipeline. An opt-in registry dispatches by file extension.

**Key exports:**

- **`PdfLoader`** — load a local PDF file or in-memory buffer.
- **`UrlLoader`** — fetch and parse an HTTPS page.
- **`CsvLoader`** — load a CSV file as structured documents.
- **`MarkdownLoader`** — load a Markdown file, splitting by headings.
- **`registerLoader` / `loadForPath`** — opt-in registry: dispatch by extension.

## Usage

```ts
import { PdfLoader, MarkdownLoader } from '@kuralle-agents/rag-loaders';

const pdfDocs  = await new PdfLoader({ filePath: './policy.pdf' }).load();
const mdDocs   = await new MarkdownLoader({ filePath: './guide.md' }).load();
```

## Loader registry

Register only what you import; unused loaders stay tree-shakeable.

```ts
import { registerLoader, loadForPath, PdfLoader, MarkdownLoader } from '@kuralle-agents/rag-loaders';

registerLoader('pdf', (path) => new PdfLoader({ filePath: path }));
registerLoader('md',  (path) => new MarkdownLoader({ filePath: path }));

const docs = await loadForPath('./whitepaper.pdf');
```

## Size limits

| Loader | Practical limit |
|--------|----------------|
| `PdfLoader` | ≤ 25 MB — `pdf-parse` loads the full document into memory. |
| `UrlLoader` | ≤ 5 MB body (configurable via `maxBytes`). |
| `CsvLoader` | ≤ 100 MB — full `Document[]` materialized in memory. |
| `MarkdownLoader` | ≤ 50 MB — full-document load. |

All loaders return `Promise<Document[]>`; streaming is not supported.

## Related

- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — chunkers, retrievers, vector stores.
- [`@kuralle-agents/tools`](https://www.npmjs.com/package/@kuralle-agents/tools) — `createVectorRetrievalTool`.
