export {
  PdfLoader,
  UrlLoader,
  CsvLoader,
  MarkdownLoader,
} from './loaders/index.js';

export type {
  PdfLoaderOptions,
  UrlLoaderOptions,
  CsvLoaderOptions,
  MarkdownLoaderOptions,
} from './loaders/index.js';

// Loader registry (opt-in)
export {
  registerLoader,
  loadForPath,
  clearRegistry,
  registeredExtensions,
} from './registry.js';
export type { LoaderFactory } from './registry.js';
