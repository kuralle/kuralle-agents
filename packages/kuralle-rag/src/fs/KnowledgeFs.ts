import type {
  CpOptions,
  FileSystem,
  FileSystemDirent,
  FileSystemEntryType,
  FsStat,
  MkdirOptions,
  RmOptions,
} from '@kuralle-agents/core';
import type { BM25Index } from '../search/BM25Index.js';
import type { VectorFilter, VectorStoreCore } from '../types.js';
import type { KnowledgeAccessFilter } from './access.js';
import { slugAllowed } from './access.js';
import {
  PATH_TREE_MANIFEST_ID,
  allChunkRecords,
  buildPathTree,
  chunkRecordsFromEntries,
  createGlobMatcher,
  groupChunksBySlug,
  joinKnowledgePath,
  normalizeKnowledgePath,
  parsePathTreeManifest,
  pathUnderRoot,
  prunePathTree,
  resolveKnowledgePath,
  type ChunkRecord,
  type PathTreeData,
} from './path-tree.js';

export interface KnowledgeFsOptions {
  store: VectorStoreCore;
  indexName: string;
  bm25?: BM25Index;
  accessFilter?: KnowledgeAccessFilter;
  manifestKey?: string;
}

export interface KnowledgeSearchHit {
  slug: string;
  chunkIndex: number;
  text: string;
}

interface VectorStoreListable {
  listEntries(
    indexName: string,
    params?: { filter?: VectorFilter },
  ): Promise<
    Array<{
      id: string;
      metadata?: Record<string, unknown>;
      document?: string;
    }>
  >;
}

function hasListEntries(store: VectorStoreCore): store is VectorStoreCore & VectorStoreListable {
  return typeof (store as unknown as VectorStoreListable).listEntries === 'function';
}

function eroFs(op: string, path: string): Error {
  return Object.assign(
    new Error(`EROFS: read-only knowledge filesystem, ${op} '${path}'`),
    { code: 'EROFS' },
  );
}

function enoent(op: string, path: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${op} '${path}'`),
    { code: 'ENOENT' },
  );
}

function enotdir(op: string, path: string): Error {
  return Object.assign(new Error(`ENOTDIR: not a directory, ${op} '${path}'`), {
    code: 'ENOTDIR',
  });
}

function eisdir(op: string, path: string): Error {
  return Object.assign(
    new Error(`EISDIR: illegal operation on a directory, ${op} '${path}'`),
    { code: 'EISDIR' },
  );
}

const utf8 = new TextEncoder();

export class KnowledgeFs implements FileSystem {
  private readonly store: VectorStoreCore;
  private readonly indexName: string;
  private readonly bm25?: BM25Index;
  private readonly accessFilter?: KnowledgeAccessFilter;
  private readonly manifestKey: string;

  private tree!: PathTreeData;
  private chunksBySlug!: Map<string, ChunkRecord[]>;
  private readonly pageCache = new Map<string, string>();
  private initialized = false;

  constructor(opts: KnowledgeFsOptions) {
    this.store = opts.store;
    this.indexName = opts.indexName;
    this.bm25 = opts.bm25;
    this.accessFilter = opts.accessFilter;
    this.manifestKey = opts.manifestKey ?? PATH_TREE_MANIFEST_ID;
  }

  static async open(opts: KnowledgeFsOptions): Promise<KnowledgeFs> {
    const fs = new KnowledgeFs(opts);
    await fs.init();
    return fs;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const filter = this.accessFilter?.vectorFilter;
    const entries = await scanStoreEntries(this.store, this.indexName, filter);
    const manifestEntry = entries.find((e) => e.id === this.manifestKey);

    let slugs: string[];
    let chunkRecords: ChunkRecord[];

    if (manifestEntry?.document) {
      slugs = parsePathTreeManifest(manifestEntry.document);
      chunkRecords = chunkRecordsFromEntries(
        entries.filter((e) => e.id !== this.manifestKey),
      );
    } else {
      chunkRecords = chunkRecordsFromEntries(entries);
      if (chunkRecords.length === 0 && entries.length > 0) {
        throw new Error(
          'KnowledgeFs: store entries lack page/chunk_index metadata required for reassembly',
        );
      }
      slugs = [...new Set(chunkRecords.map((c) => c.slug))];
    }

    const allow = (slug: string) => slugAllowed(slug, this.accessFilter);
    slugs = slugs.filter(allow);
    chunkRecords = chunkRecords.filter((c) => allow(c.slug));

    this.tree = prunePathTree(buildPathTree(slugs), allow);
    this.chunksBySlug = groupChunksBySlug(chunkRecords);
    if (this.bm25) {
      this.bm25.add(
        chunkRecords.map((r) => ({
          id: `${r.slug}#${r.chunkIndex}`,
          text: r.text,
        })),
      );
    }
    this.initialized = true;
  }

  private assertReady(): void {
    if (!this.initialized) {
      throw new Error('KnowledgeFs: call KnowledgeFs.open() before using the filesystem');
    }
  }

  private resolveCanonical(path: string): string {
    return normalizeKnowledgePath(path);
  }

  private isFile(path: string): boolean {
    return this.tree.files.has(path);
  }

  private isDirectory(path: string): boolean {
    if (path === '/') return true;
    return this.tree.dirChildren.has(path);
  }

  private assertAccessible(path: string, op: string): string {
    const canonical = this.resolveCanonical(path);
    if (canonical.includes('\0')) throw enoent(op, path);
    if (canonical !== '/' && !this.isFile(canonical) && !this.isDirectory(canonical)) {
      throw enoent(op, path);
    }
    return canonical;
  }

  async search(
    pattern: string,
    opts?: { limit?: number; path?: string },
  ): Promise<KnowledgeSearchHit[]> {
    this.assertReady();
    const limit = opts?.limit ?? 50;
    const root = opts?.path ? normalizeKnowledgePath(opts.path) : '/';

    let records = allChunkRecords(this.chunksBySlug).filter((r) =>
      pathUnderRoot(r.slug, root),
    );

    if (this.bm25) {
      const ranked = this.bm25.search(pattern, limit);
      const candidateIds = new Set(ranked.map((hit) => hit.id));
      return records
        .filter((r) => candidateIds.has(`${r.slug}#${r.chunkIndex}`))
        .slice(0, limit)
        .map((r) => ({
          slug: r.slug,
          chunkIndex: r.chunkIndex,
          text: r.text,
        }));
    }

    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      throw new Error(`EINVAL: invalid search pattern '${pattern}'`);
    }

    const hits: KnowledgeSearchHit[] = [];
    for (const record of records) {
      if (re.test(record.text)) {
        hits.push({
          slug: record.slug,
          chunkIndex: record.chunkIndex,
          text: record.text,
        });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((d) => d.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    this.assertReady();
    const canonical = this.assertAccessible(path, 'scandir');
    if (!this.isDirectory(canonical)) throw enotdir('scandir', path);

    const names = this.tree.dirChildren.get(canonical) ?? [];
    const out: FileSystemDirent[] = [];
    for (const name of names) {
      const child = joinKnowledgePath(canonical, name);
      const type: FileSystemEntryType = this.isDirectory(child) ? 'directory' : 'file';
      out.push({ name, type });
    }
    return out;
  }

  async exists(path: string): Promise<boolean> {
    this.assertReady();
    if (path.includes('\0')) return false;
    const canonical = this.resolveCanonical(path);
    if (canonical === '/') return true;
    return this.isFile(canonical) || this.isDirectory(canonical);
  }

  async stat(path: string): Promise<FsStat> {
    this.assertReady();
    const canonical = this.assertAccessible(path, 'stat');
    if (canonical === '/') {
      return { type: 'directory', size: 0, mtime: new Date(0) };
    }
    if (this.isDirectory(canonical)) {
      return { type: 'directory', size: 0, mtime: new Date(0) };
    }
    const cached = this.pageCache.get(canonical);
    if (cached !== undefined) {
      return { type: 'file', size: utf8.encode(cached).length, mtime: new Date(0) };
    }
    const chunks = this.chunksBySlug.get(canonical);
    const size = chunks?.reduce((n, c) => n + utf8.encode(c.text).length, 0) ?? 0;
    return { type: 'file', size, mtime: new Date(0) };
  }

  async lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async readFile(path: string): Promise<string> {
    this.assertReady();
    const canonical = this.assertAccessible(path, 'open');
    if (this.isDirectory(canonical)) throw eisdir('read', path);
    if (!this.isFile(canonical)) throw enoent('open', path);

    const cached = this.pageCache.get(canonical);
    if (cached !== undefined) return cached;

    const chunks = this.chunksBySlug.get(canonical);
    if (!chunks || chunks.length === 0) {
      throw enoent('open', path);
    }

    const page = chunks.map((c) => c.text).join('');
    this.pageCache.set(canonical, page);
    return page;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return utf8.encode(await this.readFile(path));
  }

  async writeFile(_path: string, _content: string): Promise<void> {
    throw eroFs('write', _path);
  }

  async writeFileBytes(path: string, _content: Uint8Array): Promise<void> {
    throw eroFs('write', path);
  }

  async appendFile(path: string, _content: string | Uint8Array): Promise<void> {
    throw eroFs('append', path);
  }

  async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
    throw eroFs('mkdir', path);
  }

  async rm(path: string, _options?: RmOptions): Promise<void> {
    throw eroFs('rm', path);
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    throw eroFs('cp', `${src} -> ${dest}`);
  }

  async mv(src: string, dest: string): Promise<void> {
    throw eroFs('rename', `${src} -> ${dest}`);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw eroFs('symlink', linkPath);
  }

  async readlink(path: string): Promise<string> {
    throw enoent('readlink', path);
  }

  resolvePath(base: string, path: string): string {
    return resolveKnowledgePath(base, path);
  }

  async realpath(path: string): Promise<string> {
    this.assertReady();
    const canonical = this.assertAccessible(path, 'realpath');
    return canonical;
  }

  async glob(pattern: string): Promise<string[]> {
    this.assertReady();
    const re = createGlobMatcher(pattern);
    const hits: string[] = [];
    for (const file of this.tree.files) {
      if (re.test(file)) hits.push(file);
    }
    return hits.sort();
  }
}

async function scanStoreEntries(
  store: VectorStoreCore,
  indexName: string,
  filter?: VectorFilter,
): Promise<
  Array<{ id: string; metadata?: Record<string, unknown>; document?: string }>
> {
  if (hasListEntries(store)) {
    return store.listEntries(indexName, { filter });
  }

  const stats = await store.describeIndex(indexName);
  const zeros = new Array<number>(stats.dimension).fill(0);
  const results = await store.query(indexName, {
    queryVector: zeros,
    topK: Math.max(stats.count, 1),
    filter,
    includeDocuments: true,
  });
  return results.map((r) => ({
    id: r.id,
    metadata: r.metadata,
    document: r.document,
  }));
}
