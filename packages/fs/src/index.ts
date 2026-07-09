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
export { CompositeFileSystem, type CompositeFileSystemConfig } from './composite-fs.js';
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
export { parseSkillFrontmatter, type ParsedSkill } from './skill-frontmatter.js';
export { fsSkillStore } from './fs-skill-store.js';
export { defineSkill } from './define-skill.js';
export {
  parseOkfConcept,
  listOkfConcepts,
  okfBundleToFs,
  type OkfConcept,
} from './okf.js';
export { SqlFileSystem, type SqlFileSystemOptions } from './sql/sql-fs.js';
export type { SqlBackend, BlobStore, SqlParam } from './sql/types.js';
export {
  sqlFileSystem,
  toSqlBackend,
  type SqlSource,
  type SqlStorageLike,
  type D1DatabaseLike,
  type SqlFileSystemFactoryOptions,
} from './sql/factory.js';
export { r2BlobStore, type R2Bucketish } from './sql/r2-blob.js';
export { libsqlHttpBackend, type LibsqlHttpOptions } from './sql/libsql-http.js';
// NOTE: shell backends (bashShell/virtualShell) live at the `@kuralle-agents/fs/shell`
// subpath, NOT the root — they pull `just-bash`, whose browser bundle depends on
// `turndown` and is not workerd-clean. Keeping them off the root export preserves the
// root package's Cloudflare Workers portability.
