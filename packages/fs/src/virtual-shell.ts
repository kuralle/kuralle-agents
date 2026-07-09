import type {
  CpOptions,
  FileSystem,
  FileSystemDirent,
  FileSystemEntryType,
  FsStat,
  MkdirOptions,
  RmOptions,
} from '@kuralle-agents/core';
import type { Shell } from '@kuralle-agents/core';
import { Bash, InMemoryFs as JustBashFs } from 'just-bash';
import { bashShell } from './bash-shell.js';
import { createGlobMatcher } from './path-utils.js';

interface JustBashStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtime: Date;
  mode?: number;
}

interface JustBashDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface JustBashFsLike {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  appendFile(path: string, content: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<JustBashStat>;
  lstat(path: string): Promise<JustBashStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<JustBashDirent[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
}

function entryType(stat: JustBashStat): FileSystemEntryType {
  if (stat.isSymbolicLink) return 'symlink';
  if (stat.isDirectory) return 'directory';
  return 'file';
}

function mapStat(stat: JustBashStat): FsStat {
  return {
    type: entryType(stat),
    size: stat.size,
    mtime: stat.mtime,
    mode: stat.mode,
  };
}

function mapDirent(entry: JustBashDirent): FileSystemDirent {
  return {
    name: entry.name,
    type: entry.isSymbolicLink
      ? 'symlink'
      : entry.isDirectory
        ? 'directory'
        : 'file',
  };
}

export function justBashFsToFileSystem(jbFs: JustBashFsLike): FileSystem {
  return {
    readFile: (path) => jbFs.readFile(path),
    readFileBytes: (path) => jbFs.readFileBuffer(path),
    writeFile: (path, content) => jbFs.writeFile(path, content),
    writeFileBytes: (path, content) => jbFs.writeFile(path, content),
    appendFile: (path, content) => jbFs.appendFile(path, content),
    exists: (path) => jbFs.exists(path),
    stat: async (path) => mapStat(await jbFs.stat(path)),
    lstat: async (path) => mapStat(await jbFs.lstat(path)),
    mkdir: (path, options) => jbFs.mkdir(path, options),
    readdir: (path) => jbFs.readdir(path),
    readdirWithFileTypes: async (path) => {
      if (jbFs.readdirWithFileTypes) {
        const entries = await jbFs.readdirWithFileTypes(path);
        return entries.map(mapDirent);
      }
      const names = await jbFs.readdir(path);
      const entries: FileSystemDirent[] = [];
      for (const name of names) {
        const child = path === '/' ? `/${name}` : `${path}/${name}`;
        const stat = await jbFs.stat(child);
        entries.push({ name, type: entryType(stat) });
      }
      return entries;
    },
    rm: (path, options) => jbFs.rm(path, options),
    cp: (src, dest, options) => jbFs.cp(src, dest, options),
    mv: (src, dest) => jbFs.mv(src, dest),
    symlink: (target, linkPath) => jbFs.symlink(target, linkPath),
    readlink: (path) => jbFs.readlink(path),
    realpath: (path) => jbFs.realpath(path),
    resolvePath: (base, path) => jbFs.resolvePath(base, path),
    glob: async (pattern) => {
      const matcher = createGlobMatcher(pattern);
      return jbFs.getAllPaths().filter((p) => matcher.test(p));
    },
  };
}

export function virtualShell(opts?: {
  initialFiles?: Record<string, string>;
}): { fs: FileSystem; shell: Shell } {
  const jbFs = new JustBashFs(opts?.initialFiles);
  const fs = justBashFsToFileSystem(jbFs);
  const bash = new Bash({ fs: jbFs });
  const shell = bashShell(bash);
  return { fs, shell };
}