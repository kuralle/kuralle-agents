import type {
  CpOptions,
  FileSystem,
  FileSystemDirent,
  FsStat,
  MkdirOptions,
  RmOptions,
} from '@kuralle-agents/core';

function readOnlyError(op: string, path: string): Error {
  return Object.assign(new Error(`EROFS: read-only filesystem, ${op} '${path}'`), {
    code: 'EROFS',
  });
}

/**
 * Capability wrapper that enforces read-only access at the filesystem boundary.
 * This matters for mixed workspaces: prompt/tool policy alone cannot protect a
 * knowledge mount when another mount intentionally accepts writes.
 */
export class ReadOnlyFileSystem implements FileSystem {
  readonly readOnly = true;

  constructor(readonly source: FileSystem) {}

  readFile(path: string): Promise<string> { return this.source.readFile(path); }
  readFileBytes(path: string): Promise<Uint8Array> { return this.source.readFileBytes(path); }
  exists(path: string): Promise<boolean> { return this.source.exists(path); }
  stat(path: string): Promise<FsStat> { return this.source.stat(path); }
  lstat(path: string): Promise<FsStat> { return this.source.lstat(path); }
  readdir(path: string): Promise<string[]> { return this.source.readdir(path); }
  readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    return this.source.readdirWithFileTypes(path);
  }
  readlink(path: string): Promise<string> { return this.source.readlink(path); }
  realpath(path: string): Promise<string> { return this.source.realpath(path); }
  resolvePath(base: string, path: string): string { return this.source.resolvePath(base, path); }
  glob(pattern: string): Promise<string[]> { return this.source.glob(pattern); }

  async writeFile(path: string, _content: string): Promise<void> { throw readOnlyError('write', path); }
  async writeFileBytes(path: string, _content: Uint8Array): Promise<void> { throw readOnlyError('write', path); }
  async appendFile(path: string, _content: string | Uint8Array): Promise<void> { throw readOnlyError('append', path); }
  async mkdir(path: string, _options?: MkdirOptions): Promise<void> { throw readOnlyError('mkdir', path); }
  async rm(path: string, _options?: RmOptions): Promise<void> { throw readOnlyError('rm', path); }
  async cp(_src: string, dest: string, _options?: CpOptions): Promise<void> { throw readOnlyError('cp', dest); }
  async mv(_src: string, dest: string): Promise<void> { throw readOnlyError('mv', dest); }
  async symlink(_target: string, linkPath: string): Promise<void> { throw readOnlyError('symlink', linkPath); }
}

export function readOnlyFileSystem(source: FileSystem): ReadOnlyFileSystem {
  return source instanceof ReadOnlyFileSystem ? source : new ReadOnlyFileSystem(source);
}
