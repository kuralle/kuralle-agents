export type {
  FileSystem,
  FsStat,
  FileSystemDirent,
  FileSystemEntryType,
  BufferEncoding,
  FileContent,
  MkdirOptions,
  RmOptions,
  CpOptions,
  ReadFileOptions,
  WriteFileOptions,
  FileEntry,
  DirectoryEntry,
  SymlinkEntry,
  LazyFileEntry,
  FsEntry,
  FileInit,
  LazyFileProvider,
  InitialFiles,
} from '@kuralle-agents/core';
export { InMemoryFs, type FsData } from './in-memory-fs.js';
export {
  normalizePath,
  validatePath,
  dirname,
  resolvePath,
  joinPath,
  resolveSymlinkTarget,
  createGlobMatcher,
  sortPaths,
  MAX_SYMLINK_DEPTH,
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
  SYMLINK_MODE,
} from './path-utils.js';
export { toBuffer, fromBuffer, getEncoding } from './encoding.js';
export { createFsTool } from './tool.js';
