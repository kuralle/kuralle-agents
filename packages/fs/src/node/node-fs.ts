import {
  cp as copy,
  lstat as nodeLstat,
  mkdir,
  readFile,
  readdir,
  readlink as nodeReadlink,
  realpath as nodeRealpath,
  rename,
  rm,
  stat as nodeStat,
  symlink as nodeSymlink,
  writeFile,
  appendFile as nodeAppendFile,
} from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import {
  dirname as hostDirname,
  isAbsolute as isHostAbsolute,
  join as hostJoin,
  relative as hostRelative,
  resolve as hostResolve,
  sep,
} from 'node:path';
import type {
  CpOptions,
  FileSystem,
  FileSystemDirent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from '@kuralle-agents/core';
import {
  createGlobMatcher,
  dirname,
  normalizePath,
  resolvePath,
  sortPaths,
  validatePath,
} from '../path-utils.js';

function isWithin(root: string, candidate: string): boolean {
  const relative = hostRelative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${sep}`) && relative !== '..' && !isHostAbsolute(relative));
}

function entryType(stat: Awaited<ReturnType<typeof nodeLstat>>): FsStat['type'] {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  return 'file';
}

function toFsStat(stat: Awaited<ReturnType<typeof nodeLstat>>): FsStat {
  return {
    type: entryType(stat),
    size: Number(stat.size),
    mtime: stat.mtime,
    mode: Number(stat.mode),
  };
}

/**
 * A Kuralle FileSystem backed by a real, caller-owned directory.
 *
 * Model-visible paths remain virtual POSIX paths (`/drafts/post.md`). Every
 * operation is confined to `root`, including paths reached through symlinks.
 * This adapter intentionally adds no methods to Kuralle's frozen FileSystem
 * contract; it only supplies the Node persistence substrate that contract was
 * missing.
 */
export class NodeFileSystem implements FileSystem {
  readonly root: string;

  constructor(root: string) {
    this.root = hostResolve(root);
    mkdirSync(this.root, { recursive: true });
    this.root = realpathSync(this.root);
  }

  private virtual(path: string, operation: string): string {
    validatePath(path, operation);
    if (path.split('/').includes('..')) {
      throw new Error(`EACCES: path traversal is not allowed, ${operation} '${path}'`);
    }
    return normalizePath(path);
  }

  private lexicalHost(path: string, operation: string): string {
    const virtual = this.virtual(path, operation);
    const host = hostResolve(this.root, `.${virtual}`);
    if (!isWithin(this.root, host)) {
      throw new Error(`EACCES: path escapes filesystem root, ${operation} '${path}'`);
    }
    return host;
  }

  private async assertResolvedWithin(host: string, operation: string, path: string): Promise<void> {
    const resolved = await nodeRealpath(host);
    if (!isWithin(this.root, resolved)) {
      throw new Error(`EACCES: symlink escapes filesystem root, ${operation} '${path}'`);
    }
  }

  private async assertParentWithin(host: string, operation: string, path: string): Promise<void> {
    let cursor = hostDirname(host);
    while (true) {
      try {
        await this.assertResolvedWithin(cursor, operation, path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const next = hostDirname(cursor);
        if (next === cursor) throw error;
        cursor = next;
      }
    }
  }

  private async assertWritableTarget(host: string, operation: string, path: string): Promise<void> {
    await this.assertParentWithin(host, operation, path);
    try {
      await nodeLstat(host);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await this.assertResolvedWithin(host, operation, path);
  }

  async readFile(path: string): Promise<string> {
    const host = this.lexicalHost(path, 'read');
    await this.assertResolvedWithin(host, 'read', path);
    return readFile(host, 'utf8');
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const host = this.lexicalHost(path, 'read');
    await this.assertResolvedWithin(host, 'read', path);
    return new Uint8Array(await readFile(host));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const host = this.lexicalHost(path, 'write');
    await this.assertWritableTarget(host, 'write', path);
    await writeFile(host, content, 'utf8');
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    const host = this.lexicalHost(path, 'write');
    await this.assertWritableTarget(host, 'write', path);
    await writeFile(host, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    const host = this.lexicalHost(path, 'append');
    await this.assertWritableTarget(host, 'append', path);
    await nodeAppendFile(host, content);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const host = this.lexicalHost(path, 'access');
      await this.assertResolvedWithin(host, 'access', path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      if (error instanceof Error && error.message.startsWith('EACCES:')) return false;
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const host = this.lexicalHost(path, 'stat');
    await this.assertResolvedWithin(host, 'stat', path);
    const stat = await nodeStat(host);
    return {
      type: stat.isDirectory() ? 'directory' : 'file',
      size: Number(stat.size),
      mtime: stat.mtime,
      mode: Number(stat.mode),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    const host = this.lexicalHost(path, 'lstat');
    await this.assertParentWithin(host, 'lstat', path);
    return toFsStat(await nodeLstat(host));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const host = this.lexicalHost(path, 'mkdir');
    await this.assertParentWithin(host, 'mkdir', path);
    await mkdir(host, { recursive: options?.recursive ?? false });
  }

  async readdir(path: string): Promise<string[]> {
    const host = this.lexicalHost(path, 'readdir');
    await this.assertResolvedWithin(host, 'readdir', path);
    return (await readdir(host)).sort();
  }

  async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    const host = this.lexicalHost(path, 'readdir');
    await this.assertResolvedWithin(host, 'readdir', path);
    const entries = await readdir(host, { withFileTypes: true });
    return entries
      .map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? ('symlink' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : ('file' as const),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const virtual = this.virtual(path, 'rm');
    if (virtual === '/') throw new Error("EBUSY: refusing to remove filesystem root, rm '/'");
    const host = this.lexicalHost(path, 'rm');
    await this.assertParentWithin(host, 'rm', path);
    await rm(host, { recursive: options?.recursive ?? false, force: options?.force ?? false });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const source = this.lexicalHost(src, 'cp');
    const target = this.lexicalHost(dest, 'cp');
    await this.assertResolvedWithin(source, 'cp', src);
    await this.assertWritableTarget(target, 'cp', dest);
    await copy(source, target, { recursive: options?.recursive ?? false, verbatimSymlinks: false });
  }

  async mv(src: string, dest: string): Promise<void> {
    const source = this.lexicalHost(src, 'rename');
    const target = this.lexicalHost(dest, 'rename');
    await this.assertParentWithin(source, 'rename', src);
    await this.assertParentWithin(target, 'rename', dest);
    await rename(source, target);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    validatePath(target, 'symlink');
    const linkVirtual = this.virtual(linkPath, 'symlink');
    const resolvedTarget = target.startsWith('/')
      ? normalizePath(target)
      : resolvePath(dirname(linkVirtual), target);
    const targetHost = this.lexicalHost(resolvedTarget, 'symlink');
    const linkHost = this.lexicalHost(linkVirtual, 'symlink');
    await this.assertParentWithin(linkHost, 'symlink', linkPath);
    const storedTarget = target.startsWith('/') ? targetHost : target;
    await nodeSymlink(storedTarget, linkHost);
  }

  async readlink(path: string): Promise<string> {
    const host = this.lexicalHost(path, 'readlink');
    await this.assertParentWithin(host, 'readlink', path);
    const target = await nodeReadlink(host);
    const resolved = hostResolve(hostDirname(host), target);
    if (!isWithin(this.root, resolved)) {
      throw new Error(`EACCES: symlink escapes filesystem root, readlink '${path}'`);
    }
    if (isHostAbsolute(target)) {
      return `/${hostRelative(this.root, resolved).split(sep).join('/')}`;
    }
    return target.split(sep).join('/');
  }

  async realpath(path: string): Promise<string> {
    const host = this.lexicalHost(path, 'realpath');
    const resolved = await nodeRealpath(host);
    if (!isWithin(this.root, resolved)) {
      throw new Error(`EACCES: symlink escapes filesystem root, realpath '${path}'`);
    }
    const relative = hostRelative(this.root, resolved).split(sep).join('/');
    return relative ? `/${relative}` : '/';
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  async glob(pattern: string): Promise<string[]> {
    const matcher = createGlobMatcher(pattern);
    const paths: string[] = [];
    const stack = ['/'];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of await this.readdirWithFileTypes(current)) {
        const child = resolvePath(current, entry.name);
        if (matcher.test(child)) paths.push(child);
        if (entry.type === 'directory') stack.push(child);
      }
    }
    return sortPaths(paths);
  }
}

export function nodeFileSystem(root: string): NodeFileSystem {
  return new NodeFileSystem(root);
}
