import type { Document, DocumentLoader } from '@kuralle-agents/rag';

/**
 * Builds a loader for a given filesystem path. Called by `loadForPath`.
 * Implementations decide how to interpret the extra options (metadata,
 * chunking hints, etc.).
 */
export type LoaderFactory = (
  path: string,
  options?: Record<string, unknown>,
) => DocumentLoader;

const registry = new Map<string, LoaderFactory>();

/**
 * Register a loader factory for a file extension. Extension is matched
 * case-insensitively without the leading dot (e.g. `'pdf'` matches
 * `my-file.PDF`).
 *
 * Re-registering the same extension overwrites the previous factory.
 */
export function registerLoader(extension: string, factory: LoaderFactory): void {
  registry.set(normalizeExt(extension), factory);
}

/**
 * Resolve the registered factory for a path's extension, instantiate the
 * loader, and call `load()`. Throws when no factory is registered for the
 * extension — callers must pre-register the loaders they need.
 */
export async function loadForPath(
  path: string,
  options?: Record<string, unknown>,
): Promise<Document[]> {
  const ext = extractExtension(path);
  const factory = ext ? registry.get(ext) : undefined;
  if (!factory) {
    throw new Error(
      `No loader registered for path "${path}" (extension: ${ext ?? '<none>'}). ` +
      `Call registerLoader(ext, factory) before loadForPath.`,
    );
  }
  const loader = factory(path, options);
  return loader.load();
}

/** Test helper: drop all registered factories. */
export function clearRegistry(): void {
  registry.clear();
}

/** List extensions currently registered. Useful for introspection. */
export function registeredExtensions(): string[] {
  return Array.from(registry.keys()).sort();
}

function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

function extractExtension(path: string): string | undefined {
  const idx = path.lastIndexOf('.');
  if (idx === -1 || idx === path.length - 1) return undefined;
  return path.slice(idx + 1).toLowerCase();
}
