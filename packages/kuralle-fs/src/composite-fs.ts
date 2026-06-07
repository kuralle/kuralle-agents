import type {
  CpOptions,
  FileSystem,
  FileSystemDirent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from '@kuralle-agents/core';
import { normalizePath, sortPaths } from './path-utils.js';

export interface CompositeFileSystemConfig {
  mounts: Record<string, FileSystem>;
}

interface ResolvedMount {
  fs: FileSystem;
  fsPath: string;
  mountPath: string;
}

interface MountWithReadOnly extends FileSystem {
  readOnly?: boolean;
}

function mountReadOnly(fs: FileSystem): boolean {
  return (fs as MountWithReadOnly).readOnly === true;
}

function enoent(op: string, path: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, ${op} '${path}'`),
    { code: 'ENOENT' },
  );
}

function eroFs(op: string, path: string): Error {
  return Object.assign(new Error(`EROFS: read-only filesystem, ${op} '${path}'`), {
    code: 'EROFS',
  });
}

export class CompositeFileSystem implements FileSystem {
  readonly readOnly?: boolean;

  private readonly _mounts: Map<string, FileSystem>;

  constructor(config: CompositeFileSystemConfig) {
    this._mounts = new Map();
    for (const [path, fs] of Object.entries(config.mounts)) {
      this._mounts.set(this.normalizeMountPath(path), fs);
    }
    if (this._mounts.size === 0) {
      throw new Error('CompositeFileSystem requires at least one mount');
    }

    const mountPaths = [...this._mounts.keys()];
    for (const a of mountPaths) {
      for (const b of mountPaths) {
        if (a !== b && b.startsWith(a + '/')) {
          throw new Error(
            `Nested mount paths are not supported: "${b}" is nested under "${a}"`,
          );
        }
      }
    }

    this.readOnly = [...this._mounts.values()].every(mountReadOnly) || undefined;
  }

  get mountPaths(): string[] {
    return [...this._mounts.keys()];
  }

  resolveMount(path: string): ResolvedMount | null {
    const normalized = normalizePath(path);
    let best: { mountPath: string; fs: FileSystem } | null = null;

    for (const [mountPath, fs] of this._mounts) {
      if (normalized === mountPath || normalized.startsWith(mountPath + '/')) {
        if (!best || mountPath.length > best.mountPath.length) {
          best = { mountPath, fs };
        }
      }
    }

    if (!best) return null;

    let fsPath = normalized.slice(best.mountPath.length);
    if (fsPath === '/') fsPath = '';
    else if (fsPath.startsWith('/')) fsPath = fsPath.slice(1);

    return { fs: best.fs, mountPath: best.mountPath, fsPath };
  }

  private normalizeMountPath(path: string): string {
    if (!path || path === '/' || path === '.') return '/';
    let n = normalizePath(path);
    if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
    return n;
  }

  private assertWritable(fs: FileSystem, path: string, op: string): void {
    if (mountReadOnly(fs)) throw eroFs(op, path);
  }

  private isVirtualPath(path: string): boolean {
    const normalized = normalizePath(path);
    if (normalized === '/' && !this._mounts.has('/')) return true;
    for (const mountPath of this._mounts.keys()) {
      if (mountPath.startsWith(normalized + '/')) return true;
    }
    return false;
  }

  private getVirtualEntries(path: string): string[] | null {
    const normalized = normalizePath(path);
    if (this.resolveMount(normalized)) return null;

    const names = new Set<string>();
    for (const mountPath of this._mounts.keys()) {
      const isUnder =
        normalized === '/'
          ? mountPath.startsWith('/')
          : mountPath.startsWith(normalized + '/');
      if (!isUnder) continue;

      const remaining =
        normalized === '/' ? mountPath.slice(1) : mountPath.slice(normalized.length + 1);
      const next = remaining.split('/')[0];
      if (next) names.add(next);
    }

    return names.size > 0 ? sortPaths([...names]) : null;
  }

  private getVirtualDirents(path: string): FileSystemDirent[] | null {
    const names = this.getVirtualEntries(path);
    if (!names) return null;
    return names.map((name) => ({ name, type: 'directory' as const }));
  }

  private mountRootStat(path: string): FsStat {
    const normalized = normalizePath(path);
    const parts = normalized.split('/').filter(Boolean);
    const now = new Date();
    return {
      type: 'directory',
      size: 0,
      mtime: now,
    };
  }

  private toCompositePath(mountPath: string, fsPath: string): string {
    if (mountPath === '/') return fsPath === '' ? '/' : `/${fsPath}`;
    return fsPath === '' ? mountPath : `${mountPath}/${fsPath}`;
  }

  async readFile(path: string): Promise<string> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('open', path);
    return r.fs.readFile(r.fsPath === '' ? '/' : `/${r.fsPath}`);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('open', path);
    return r.fs.readFileBytes(r.fsPath === '' ? '/' : `/${r.fsPath}`);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('write', path);
    this.assertWritable(r.fs, path, 'write');
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.writeFile(target, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('write', path);
    this.assertWritable(r.fs, path, 'write');
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.writeFileBytes(target, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('append', path);
    this.assertWritable(r.fs, path, 'append');
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.appendFile(target, content);
  }

  async exists(path: string): Promise<boolean> {
    if (this.isVirtualPath(path)) return true;
    const r = this.resolveMount(path);
    if (!r) return false;
    if (r.fsPath === '') return true;
    return r.fs.exists(`/${r.fsPath}`);
  }

  async stat(path: string): Promise<FsStat> {
    if (this.isVirtualPath(path)) return this.mountRootStat(path);
    const r = this.resolveMount(path);
    if (!r) throw enoent('stat', path);
    if (r.fsPath === '') return this.mountRootStat(path);
    return r.fs.stat(`/${r.fsPath}`);
  }

  async lstat(path: string): Promise<FsStat> {
    if (this.isVirtualPath(path)) return this.mountRootStat(path);
    const r = this.resolveMount(path);
    if (!r) throw enoent('lstat', path);
    if (r.fsPath === '') return this.mountRootStat(path);
    return r.fs.lstat(`/${r.fsPath}`);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('mkdir', path);
    this.assertWritable(r.fs, path, 'mkdir');
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.mkdir(target, options);
  }

  async readdir(path: string): Promise<string[]> {
    const virtual = this.getVirtualEntries(path);
    if (virtual) return virtual;
    const r = this.resolveMount(path);
    if (!r) throw enoent('scandir', path);
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.readdir(target);
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    const virtual = this.getVirtualDirents(path);
    if (virtual) return virtual;
    const r = this.resolveMount(path);
    if (!r) throw enoent('scandir', path);
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.readdirWithFileTypes(target);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('rm', path);
    this.assertWritable(r.fs, path, 'rm');
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.rm(target, options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcR = this.resolveMount(src);
    const destR = this.resolveMount(dest);
    if (!srcR) throw enoent('cp', src);
    if (!destR) throw enoent('cp', dest);
    this.assertWritable(destR.fs, dest, 'cp');

    const srcPath = srcR.fsPath === '' ? '/' : `/${srcR.fsPath}`;
    const destPath = destR.fsPath === '' ? '/' : `/${destR.fsPath}`;

    if (srcR.mountPath === destR.mountPath) {
      return srcR.fs.cp(srcPath, destPath, options);
    }

    const bytes = await srcR.fs.readFileBytes(srcPath);
    await destR.fs.writeFileBytes(destPath, bytes);
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcR = this.resolveMount(src);
    const destR = this.resolveMount(dest);
    if (!srcR) throw enoent('mv', src);
    if (!destR) throw enoent('mv', dest);
    this.assertWritable(destR.fs, dest, 'mv');
    this.assertWritable(srcR.fs, src, 'mv');

    const srcPath = srcR.fsPath === '' ? '/' : `/${srcR.fsPath}`;
    const destPath = destR.fsPath === '' ? '/' : `/${destR.fsPath}`;

    if (srcR.mountPath === destR.mountPath) {
      return srcR.fs.mv(srcPath, destPath);
    }

    await this.cp(src, dest);
    await srcR.fs.rm(srcPath, { recursive: true, force: true });
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const r = this.resolveMount(linkPath);
    if (!r) throw enoent('symlink', linkPath);
    this.assertWritable(r.fs, linkPath, 'symlink');
    const targetPath = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.symlink(target, targetPath);
  }

  async readlink(path: string): Promise<string> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('readlink', path);
    const target = r.fsPath === '' ? '/' : `/${r.fsPath}`;
    return r.fs.readlink(target);
  }

  async realpath(path: string): Promise<string> {
    const r = this.resolveMount(path);
    if (!r) throw enoent('realpath', path);
    if (r.fsPath === '') return r.mountPath;
    const inner = await r.fs.realpath(`/${r.fsPath}`);
    return this.toCompositePath(r.mountPath, inner === '/' ? '' : inner.slice(1));
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path);
    const combined = base === '/' ? `/${path}` : `${base}/${path}`;
    return normalizePath(combined);
  }

  async glob(pattern: string): Promise<string[]> {
    const hits: string[] = [];
    for (const [mountPath, fs] of this._mounts) {
      const mountHits = await fs.glob(pattern);
      for (const hit of mountHits) {
        if (mountPath === '/') {
          hits.push(hit);
        } else {
          const suffix = hit === '/' ? '' : hit.startsWith('/') ? hit : `/${hit}`;
          hits.push(`${mountPath}${suffix}`);
        }
      }
    }
    return sortPaths([...new Set(hits)]);
  }
}
