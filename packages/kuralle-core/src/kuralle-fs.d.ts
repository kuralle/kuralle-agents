declare module '@kuralle-agents/fs' {
  import type { FileSystem } from './types/filesystem.js';
  import type { AnyTool } from './types/effectTool.js';

  export function createFsTool(opts: {
    fs: FileSystem;
    readOnly?: boolean;
    timeoutMs?: number;
  }): AnyTool;

  export class InMemoryFs implements FileSystem {
    constructor(initialFiles?: Record<string, string | Uint8Array>);
    readFile(path: string): Promise<string>;
    readFileBytes(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: string): Promise<void>;
    writeFileBytes(path: string, content: Uint8Array): Promise<void>;
    appendFile(path: string, content: string | Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<import('./types/filesystem.js').FsStat>;
    lstat(path: string): Promise<import('./types/filesystem.js').FsStat>;
    mkdir(path: string, options?: import('./types/filesystem.js').MkdirOptions): Promise<void>;
    readdir(path: string): Promise<string[]>;
    readdirWithFileTypes(path: string): Promise<import('./types/filesystem.js').FileSystemDirent[]>;
    rm(path: string, options?: import('./types/filesystem.js').RmOptions): Promise<void>;
    cp(src: string, dest: string, options?: import('./types/filesystem.js').CpOptions): Promise<void>;
    mv(src: string, dest: string): Promise<void>;
    symlink(target: string, linkPath: string): Promise<void>;
    readlink(path: string): Promise<string>;
    realpath(path: string): Promise<string>;
    resolvePath(base: string, path: string): string;
    glob(pattern: string): Promise<string[]>;
  }
}
