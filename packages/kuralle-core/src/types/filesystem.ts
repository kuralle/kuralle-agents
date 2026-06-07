export type FileSystemEntryType = 'file' | 'directory' | 'symlink';

export type BufferEncoding =
  | 'utf8'
  | 'utf-8'
  | 'ascii'
  | 'binary'
  | 'base64'
  | 'hex'
  | 'latin1';

export type FileContent = string | Uint8Array;

export interface FsStat {
  type: FileSystemEntryType;
  size: number;
  mtime: Date;
  mode?: number;
}

export interface FileSystemDirent {
  name: string;
  type: FileSystemEntryType;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

export interface FileSystem {
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(path: string, content: Uint8Array): Promise<void>;
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  lstat(path: string): Promise<FsStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes(path: string): Promise<FileSystemDirent[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  resolvePath(base: string, path: string): string;
  glob(pattern: string): Promise<string[]>;
}

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export interface FileEntry {
  type: 'file';
  content: string | Uint8Array;
  mode: number;
  mtime: Date;
}

export interface DirectoryEntry {
  type: 'directory';
  mode: number;
  mtime: Date;
}

export interface SymlinkEntry {
  type: 'symlink';
  target: string;
  mode: number;
  mtime: Date;
}

export interface LazyFileEntry {
  type: 'file';
  lazy: () => string | Uint8Array | Promise<string | Uint8Array>;
  mode: number;
  mtime: Date;
}

export type FsEntry = FileEntry | LazyFileEntry | DirectoryEntry | SymlinkEntry;

export interface FileInit {
  content: FileContent;
  mode?: number;
  mtime?: Date;
}

export type LazyFileProvider = () =>
  | string
  | Uint8Array
  | Promise<string | Uint8Array>;

export type InitialFiles = Record<
  string,
  FileContent | FileInit | LazyFileProvider
>;

export interface FsError extends Error {
  code?: string;
}

export function fsErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = err.message.match(/^([A-Z]+):/);
  return match?.[1];
}
