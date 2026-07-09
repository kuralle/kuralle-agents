import type {
  CpOptions,
  FileSystem,
  FileSystemDirent,
  FileSystemEntryType,
  FsStat,
  MkdirOptions,
  RmOptions,
} from '@kuralle-agents/core';
import { fromBuffer } from '../encoding.js';
import {
  createGlobMatcher,
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  dirname,
  MAX_SYMLINK_DEPTH,
  normalizePath,
  resolvePath as resolvePathUtil,
  sortPaths,
  SYMLINK_MODE,
  validatePath,
} from '../path-utils.js';
import type { BlobStore, SqlBackend } from './types.js';

export interface SqlFileSystemOptions {
  backend: SqlBackend;
  namespace?: string;
  blobs?: BlobStore;
  inlineThreshold?: number;
}

const DEFAULT_INLINE_THRESHOLD = 1_500_000;
const VALID_NAMESPACE = /^[a-z][a-z0-9_]*$/i;
const TEXT_ENCODER = new TextEncoder();

interface FileRow {
  path: string;
  parent_path: string;
  name: string;
  type: FileSystemEntryType;
  mime_type: string;
  size: number;
  storage_backend: 'inline' | 'blob';
  blob_key: string | null;
  target: string | null;
  content_encoding: string;
  content: string | null;
  created_at: number;
  modified_at: number;
}

function split(normalized: string): string[] {
  return normalized === '/' ? [] : normalized.slice(1).split('/');
}

function basename(path: string): string {
  const norm = normalizePath(path);
  if (norm === '/') return '';
  return norm.slice(norm.lastIndexOf('/') + 1);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 8192;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.byteLength)),
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function rowMtime(row: { modified_at: number }): Date {
  return new Date(row.modified_at * 1000);
}

function rowToStat(row: FileRow): FsStat {
  return {
    type: row.type,
    size: row.type === 'symlink' ? (row.target?.length ?? 0) : row.size,
    mtime: rowMtime(row),
    mode:
      row.type === 'directory'
        ? DEFAULT_DIR_MODE
        : row.type === 'symlink'
          ? SYMLINK_MODE
          : DEFAULT_FILE_MODE,
  };
}

export class SqlFileSystem implements FileSystem {
  private readonly backend: SqlBackend;
  private readonly namespace: string;
  private readonly tableName: string;
  private readonly indexName: string;
  private readonly blobs: BlobStore | undefined;
  private readonly threshold: number;
  private initPromise: Promise<void> | null = null;

  constructor(opts: SqlFileSystemOptions) {
    const ns = opts.namespace ?? 'default';
    if (!VALID_NAMESPACE.test(ns)) {
      throw new Error(
        `Invalid namespace "${ns}": must start with a letter and contain only alphanumeric characters or underscores`,
      );
    }
    this.backend = opts.backend;
    this.namespace = ns;
    this.tableName = `${ns}_files`;
    this.indexName = `${ns}_files_parent`;
    this.blobs = opts.blobs;
    this.threshold = opts.inlineThreshold ?? DEFAULT_INLINE_THRESHOLD;
  }

  async init(): Promise<void> {
    await this.ensureInit();
  }

  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    const T = this.tableName;
    const I = this.indexName;

    await this.backend.run(`
      CREATE TABLE IF NOT EXISTS ${T} (
        path            TEXT PRIMARY KEY,
        parent_path     TEXT NOT NULL,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL CHECK(type IN ('file','directory','symlink')),
        mime_type       TEXT NOT NULL DEFAULT 'text/plain',
        size            INTEGER NOT NULL DEFAULT 0,
        storage_backend TEXT NOT NULL DEFAULT 'inline' CHECK(storage_backend IN ('inline','blob')),
        blob_key        TEXT,
        target          TEXT,
        content_encoding TEXT NOT NULL DEFAULT 'utf8',
        content         TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
        modified_at     INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);

    await this.backend.run(
      `CREATE INDEX IF NOT EXISTS ${I} ON ${T}(parent_path)`,
    );

    const hasRoot =
      (
        await this.backend.query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM ${T} WHERE path = '/'`,
        )
      )[0]?.cnt ?? 0;

    if (hasRoot === 0) {
      const now = Math.floor(Date.now() / 1000);
      await this.backend.run(
        `INSERT INTO ${T}
          (path, parent_path, name, type, size, created_at, modified_at)
        VALUES ('/', '', '', 'directory', 0, ?, ?)`,
        now,
        now,
      );
    }
  }

  private missing(op: string, path: string): Error {
    return new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
  }

  private blobKey(filePath: string): string {
    return `${this.namespace}:${filePath}`;
  }

  private async getRow(path: string): Promise<FileRow | null> {
    const T = this.tableName;
    const rows = await this.backend.query<FileRow>(
      `SELECT path, parent_path, name, type, mime_type, size,
              storage_backend, blob_key, target, content_encoding, content,
              created_at, modified_at
       FROM ${T} WHERE path = ?`,
      path,
    );
    return rows[0] ?? null;
  }

  private async readBytesFromRow(row: FileRow): Promise<Uint8Array> {
    if (row.storage_backend === 'blob' && row.blob_key) {
      if (!this.blobs) {
        throw new Error(
          `File ${row.path} is stored in blob but no BlobStore was provided`,
        );
      }
      const data = await this.blobs.get(row.blob_key);
      return data ?? new Uint8Array(0);
    }
    if (row.content_encoding === 'base64' && row.content) {
      return base64ToBytes(row.content);
    }
    return TEXT_ENCODER.encode(row.content ?? '');
  }

  private async deleteBlobIfNeeded(row: FileRow): Promise<void> {
    if (
      row.storage_backend === 'blob' &&
      row.blob_key &&
      this.blobs
    ) {
      await this.blobs.delete(row.blob_key);
    }
  }

  private async insertDirectory(path: string): Promise<void> {
    const T = this.tableName;
    const parent = dirname(path);
    const name = basename(path);
    const now = Math.floor(Date.now() / 1000);
    await this.backend.run(
      `INSERT INTO ${T}
        (path, parent_path, name, type, size, created_at, modified_at)
      VALUES (?, ?, ?, 'directory', 0, ?, ?)`,
      path,
      parent,
      name,
      now,
      now,
    );
  }

  private async scaffoldForPath(normalized: string): Promise<void> {
    const segs = split(normalized);
    if (segs.length <= 1) return;

    let current = '/';
    for (let i = 0; i < segs.length - 1; i++) {
      const childPath =
        current === '/' ? `/${segs[i]}` : `${current}/${segs[i]}`;
      const row = await this.getRow(childPath);
      if (row) {
        if (row.type === 'directory') {
          current = childPath;
          continue;
        }
        await this.deleteBlobIfNeeded(row);
        const T = this.tableName;
        await this.backend.run(`DELETE FROM ${T} WHERE path = ?`, childPath);
        await this.insertDirectory(childPath);
        current = childPath;
      } else {
        await this.insertDirectory(childPath);
        current = childPath;
      }
    }
  }

  private async locate(
    rawPath: string,
    followLast: boolean,
    op: string,
  ): Promise<FileRow | null> {
    const norm = normalizePath(rawPath);
    if (norm === '/') return null;

    const pending = [...split(norm)];
    const trail: string[] = [];
    let budget = MAX_SYMLINK_DEPTH;

    while (pending.length > 0) {
      const seg = pending.shift()!;
      const currentPath =
        trail.length === 0 ? `/${seg}` : `/${trail.join('/')}/${seg}`;
      const row = await this.getRow(currentPath);
      if (!row) return null;

      const last = pending.length === 0;

      if (row.type === 'symlink' && (!last || followLast)) {
        if (--budget < 0) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, ${op} '${rawPath}'`,
          );
        }
        const base = trail.length > 0 ? '/' + trail.join('/') : '';
        const abs = row.target!.startsWith('/')
          ? normalizePath(row.target!)
          : normalizePath(
              base === '/' ? `/${row.target}` : `${base}/${row.target}`,
            );
        pending.unshift(...split(abs));
        trail.length = 0;
        continue;
      }

      if (last) return row;
      if (row.type !== 'directory') return null;
      trail.push(seg);
    }

    return null;
  }

  private async canonicalize(rawPath: string): Promise<string | null> {
    const norm = normalizePath(rawPath);
    if (norm === '/') return '/';

    const pending = [...split(norm)];
    const resolved: string[] = [];
    let budget = MAX_SYMLINK_DEPTH;

    while (pending.length > 0) {
      const seg = pending.shift()!;
      const currentPath =
        resolved.length === 0
          ? `/${seg}`
          : `/${resolved.join('/')}/${seg}`;
      const row = await this.getRow(currentPath);
      if (!row) return null;

      if (row.type === 'symlink') {
        if (--budget < 0) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, realpath '${rawPath}'`,
          );
        }
        const base = resolved.length > 0 ? '/' + resolved.join('/') : '';
        const abs = row.target!.startsWith('/')
          ? normalizePath(row.target!)
          : normalizePath(
              base === '/' ? `/${row.target}` : `${base}/${row.target}`,
            );
        pending.unshift(...split(abs));
        resolved.length = 0;
        continue;
      }

      resolved.push(seg);
      if (row.type !== 'directory' && pending.length > 0) return null;
    }

    return '/' + resolved.join('/');
  }

  async readFile(path: string): Promise<string> {
    return fromBuffer(await this.readFileBytes(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    await this.ensureInit();
    validatePath(path, 'open');
    if (normalizePath(path) === '/') {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }
    const row = await this.locate(path, true, 'open');
    if (!row) throw this.missing('open', path);
    if (row.type === 'directory' || row.type === 'symlink') {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }
    return this.readBytesFromRow(row);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureInit();
    validatePath(path, 'write');
    const norm = normalizePath(path);
    if (norm === '/') {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`,
      );
    }

    await this.scaffoldForPath(norm);

    const bytes = TEXT_ENCODER.encode(content);
    const size = bytes.byteLength;
    const parent = dirname(norm);
    const name = basename(norm);
    const now = Math.floor(Date.now() / 1000);
    const T = this.tableName;

    const existing = await this.getRow(norm);
    if (existing) {
      await this.deleteBlobIfNeeded(existing);
    }

    if (size >= this.threshold && this.blobs) {
      const key = this.blobKey(norm);
      await this.blobs.put(key, bytes);
      await this.backend.run(
        `INSERT INTO ${T}
          (path, parent_path, name, type, mime_type, size,
           storage_backend, blob_key, content_encoding, content, created_at, modified_at)
        VALUES (?, ?, ?, 'file', 'text/plain', ?, 'blob', ?, 'utf8', NULL, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          parent_path = excluded.parent_path,
          name = excluded.name,
          type = 'file',
          mime_type = excluded.mime_type,
          size = excluded.size,
          storage_backend = 'blob',
          blob_key = excluded.blob_key,
          content_encoding = 'utf8',
          content = NULL,
          modified_at = excluded.modified_at`,
        norm,
        parent,
        name,
        size,
        key,
        now,
        now,
      );
      return;
    }

    await this.backend.run(
      `INSERT INTO ${T}
        (path, parent_path, name, type, mime_type, size,
         storage_backend, blob_key, content_encoding, content, created_at, modified_at)
      VALUES (?, ?, ?, 'file', 'text/plain', ?, 'inline', NULL, 'utf8', ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        parent_path = excluded.parent_path,
        name = excluded.name,
        type = 'file',
        mime_type = excluded.mime_type,
        size = excluded.size,
        storage_backend = 'inline',
        blob_key = NULL,
        content_encoding = 'utf8',
        content = excluded.content,
        modified_at = excluded.modified_at`,
      norm,
      parent,
      name,
      size,
      content,
      now,
      now,
    );
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.ensureInit();
    validatePath(path, 'write');
    const norm = normalizePath(path);
    if (norm === '/') {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`,
      );
    }

    await this.scaffoldForPath(norm);

    const parent = dirname(norm);
    const name = basename(norm);
    const size = content.byteLength;
    const now = Math.floor(Date.now() / 1000);
    const T = this.tableName;

    const existing = await this.getRow(norm);
    if (existing) {
      await this.deleteBlobIfNeeded(existing);
    }

    if (size >= this.threshold && this.blobs) {
      const key = this.blobKey(norm);
      await this.blobs.put(key, content);
      await this.backend.run(
        `INSERT INTO ${T}
          (path, parent_path, name, type, mime_type, size,
           storage_backend, blob_key, content_encoding, content, created_at, modified_at)
        VALUES (?, ?, ?, 'file', 'application/octet-stream', ?, 'blob', ?, 'base64', NULL, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          parent_path = excluded.parent_path,
          name = excluded.name,
          type = 'file',
          mime_type = excluded.mime_type,
          size = excluded.size,
          storage_backend = 'blob',
          blob_key = excluded.blob_key,
          content_encoding = 'base64',
          content = NULL,
          modified_at = excluded.modified_at`,
        norm,
        parent,
        name,
        size,
        key,
        now,
        now,
      );
      return;
    }

    const b64 = bytesToBase64(content);
    await this.backend.run(
      `INSERT INTO ${T}
        (path, parent_path, name, type, mime_type, size,
         storage_backend, blob_key, content_encoding, content, created_at, modified_at)
      VALUES (?, ?, ?, 'file', 'application/octet-stream', ?, 'inline', NULL, 'base64', ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        parent_path = excluded.parent_path,
        name = excluded.name,
        type = 'file',
        mime_type = excluded.mime_type,
        size = excluded.size,
        storage_backend = 'inline',
        blob_key = NULL,
        content_encoding = 'base64',
        content = excluded.content,
        modified_at = excluded.modified_at`,
      norm,
      parent,
      name,
      size,
      b64,
      now,
      now,
    );
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.ensureInit();
    validatePath(path, 'append');
    const extra =
      typeof content === 'string' ? TEXT_ENCODER.encode(content) : content;
    const row = await this.locate(path, true, 'append');

    if (row?.type === 'directory') {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`,
      );
    }

    if (!row) {
      await this.writeFileBytes(path, extra);
      return;
    }

    if (row.type === 'symlink') {
      await this.writeFileBytes(path, extra);
      return;
    }

    const existing = await this.readBytesFromRow(row);
    const merged = new Uint8Array(existing.length + extra.length);
    merged.set(existing);
    merged.set(extra, existing.length);
    await this.writeFileBytes(row.path, merged);
  }

  async exists(path: string): Promise<boolean> {
    await this.ensureInit();
    if (path.includes('\0')) return false;
    try {
      if (normalizePath(path) === '/') return true;
      return (await this.locate(path, true, 'access')) !== null;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    await this.ensureInit();
    validatePath(path, 'stat');
    if (normalizePath(path) === '/') {
      const root = await this.getRow('/');
      return {
        type: 'directory',
        size: 0,
        mtime: root ? rowMtime(root) : new Date(),
        mode: DEFAULT_DIR_MODE,
      };
    }
    const row = await this.locate(path, true, 'stat');
    if (!row) throw this.missing('stat', path);
    return rowToStat(row);
  }

  async lstat(path: string): Promise<FsStat> {
    await this.ensureInit();
    validatePath(path, 'lstat');
    if (normalizePath(path) === '/') {
      const root = await this.getRow('/');
      return {
        type: 'directory',
        size: 0,
        mtime: root ? rowMtime(root) : new Date(),
        mode: DEFAULT_DIR_MODE,
      };
    }
    const row = await this.locate(path, false, 'lstat');
    if (!row) throw this.missing('lstat', path);
    if (row.type === 'symlink') {
      return {
        type: 'symlink',
        size: row.target?.length ?? 0,
        mtime: rowMtime(row),
        mode: SYMLINK_MODE,
      };
    }
    return rowToStat(row);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.ensureInit();
    validatePath(path, 'mkdir');
    const norm = normalizePath(path);
    if (norm === '/') {
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }

    const existing = await this.getRow(norm);
    if (existing) {
      if (existing.type === 'directory') {
        if (!options?.recursive) {
          throw new Error(
            `EEXIST: directory already exists, mkdir '${path}'`,
          );
        }
        return;
      }
      throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
    }

    const segs = split(norm);
    let dirPath = '/';
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1;
      const childPath =
        dirPath === '/' ? `/${segs[i]}` : `${dirPath}/${segs[i]}`;
      const child = await this.getRow(childPath);

      if (child) {
        if (child.type === 'directory') {
          if (last) {
            if (!options?.recursive) {
              throw new Error(
                `EEXIST: directory already exists, mkdir '${path}'`,
              );
            }
            return;
          }
          dirPath = childPath;
        } else if (last) {
          throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
        } else if (options?.recursive) {
          await this.deleteBlobIfNeeded(child);
          const T = this.tableName;
          await this.backend.run(`DELETE FROM ${T} WHERE path = ?`, childPath);
          await this.insertDirectory(childPath);
          dirPath = childPath;
        } else {
          throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
        }
      } else if (last) {
        await this.insertDirectory(childPath);
      } else if (options?.recursive) {
        await this.insertDirectory(childPath);
        dirPath = childPath;
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((d) => d.name);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    await this.ensureInit();
    validatePath(path, 'scandir');
    const norm = normalizePath(path);
    const row = await this.locate(path, true, 'scandir');
    if (!row) throw this.missing('scandir', path);
    if (row.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const T = this.tableName;
    const rows = await this.backend.query<{ name: string; type: string }>(
      `SELECT name, type FROM ${T} WHERE parent_path = ? ORDER BY name`,
      norm,
    );

    return rows.map((r) => ({
      name: r.name,
      type: r.type as FileSystemEntryType,
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.ensureInit();
    validatePath(path, 'rm');
    const norm = normalizePath(path);
    if (norm === '/') {
      if (options?.force) return;
      throw new Error(`EPERM: cannot remove root, rm '${path}'`);
    }

    const row = await this.getRow(norm);
    if (!row) {
      if (options?.force) return;
      throw this.missing('rm', path);
    }

    if (row.type === 'directory') {
      const T = this.tableName;
      const children = await this.backend.query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM ${T} WHERE parent_path = ?`,
        norm,
      );
      if ((children[0]?.cnt ?? 0) > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        await this.deleteDescendants(norm);
      }
    } else {
      await this.deleteBlobIfNeeded(row);
    }

    const T = this.tableName;
    await this.backend.run(`DELETE FROM ${T} WHERE path = ?`, norm);
  }

  private async deleteDescendants(dirPath: string): Promise<void> {
    const T = this.tableName;
    const pattern = `${dirPath}/%`;
    const blobRows = await this.backend.query<{ blob_key: string }>(
      `SELECT blob_key FROM ${T}
       WHERE path LIKE ?
         AND storage_backend = 'blob'
         AND blob_key IS NOT NULL`,
      pattern,
    );
    if (this.blobs) {
      for (const r of blobRows) {
        await this.blobs.delete(r.blob_key);
      }
    }
    await this.backend.run(`DELETE FROM ${T} WHERE path LIKE ?`, pattern);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.ensureInit();
    validatePath(src, 'cp');
    validatePath(dest, 'cp');
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcRow = await this.locate(src, false, 'cp');
    if (!srcRow) throw this.missing('cp', src);

    if (srcRow.type === 'symlink') {
      await this.symlink(srcRow.target!, dest);
      return;
    }

    if (srcRow.type === 'directory') {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdirWithFileTypes(srcNorm);
      for (const child of children) {
        const childSrc =
          srcNorm === '/' ? `/${child.name}` : `${srcNorm}/${child.name}`;
        const childDest =
          destNorm === '/' ? `/${child.name}` : `${destNorm}/${child.name}`;
        await this.cp(childSrc, childDest, options);
      }
      return;
    }

    const bytes = await this.readFileBytes(srcNorm);
    await this.writeFileBytes(destNorm, bytes);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.ensureInit();
    validatePath(src, 'mv');
    validatePath(dest, 'mv');
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);
    const srcRow = await this.locate(src, false, 'mv');
    if (!srcRow) throw this.missing('mv', src);

    if (srcRow.type === 'directory') {
      await this.cp(src, dest, { recursive: true });
      await this.rm(src, { recursive: true });
      return;
    }

    const destParent = dirname(destNorm);
    const destName = basename(destNorm);
    await this.scaffoldForPath(destNorm);

    const existingDest = await this.getRow(destNorm);
    if (existingDest) {
      await this.deleteBlobIfNeeded(existingDest);
      const T = this.tableName;
      await this.backend.run(`DELETE FROM ${T} WHERE path = ?`, destNorm);
    }

    const now = Math.floor(Date.now() / 1000);
    const T = this.tableName;

    if (
      srcRow.type === 'file' &&
      srcRow.storage_backend === 'blob' &&
      srcRow.blob_key
    ) {
      await this.backend.run(
        `UPDATE ${T} SET
          path = ?,
          parent_path = ?,
          name = ?,
          modified_at = ?
        WHERE path = ?`,
        destNorm,
        destParent,
        destName,
        now,
        srcNorm,
      );
      return;
    }

    await this.backend.run(
      `UPDATE ${T} SET
        path = ?,
        parent_path = ?,
        name = ?,
        modified_at = ?
      WHERE path = ?`,
      destNorm,
      destParent,
      destName,
      now,
      srcNorm,
    );
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.ensureInit();
    validatePath(linkPath, 'symlink');
    const norm = normalizePath(linkPath);
    const segs = split(norm);
    if (segs.length === 0) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }
    await this.scaffoldForPath(norm);
    const existing = await this.getRow(norm);
    if (existing) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    const parent = dirname(norm);
    const name = basename(norm);
    const now = Math.floor(Date.now() / 1000);
    const T = this.tableName;
    await this.backend.run(
      `INSERT INTO ${T}
        (path, parent_path, name, type, target, size, created_at, modified_at)
      VALUES (?, ?, ?, 'symlink', ?, 0, ?, ?)`,
      norm,
      parent,
      name,
      target,
      now,
      now,
    );
  }

  async readlink(path: string): Promise<string> {
    await this.ensureInit();
    validatePath(path, 'readlink');
    const row = await this.locate(path, false, 'readlink');
    if (!row) throw this.missing('readlink', path);
    if (row.type !== 'symlink' || !row.target) {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }
    return row.target;
  }

  async realpath(path: string): Promise<string> {
    await this.ensureInit();
    validatePath(path, 'realpath');
    const canon = await this.canonicalize(path);
    if (canon === null) throw this.missing('realpath', path);
    return canon;
  }

  resolvePath(base: string, path: string): string {
    return resolvePathUtil(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    await this.ensureInit();
    const re = createGlobMatcher(pattern);
    const T = this.tableName;
    const rows = await this.backend.query<{ path: string }>(
      `SELECT path FROM ${T}`,
    );
    const hits = rows.map((r) => r.path).filter((p) => re.test(p));
    return sortPaths(hits);
  }
}