import {
  fsSkillStore,
  type FileSystem,
  type FileSystemDirent,
  type FsStat,
  type SkillStoreLike,
} from '@kuralle-agents/core';
import {
  CompositeFileSystem,
  createGlobMatcher,
  normalizePath,
  ReadOnlyFileSystem,
  readOnlyFileSystem,
  sortPaths,
} from '@kuralle-agents/fs';
import { nodeFileSystem } from '@kuralle-agents/fs/node/fs';
import type { ReleaseAgentConfig } from './types.js';

export const WORKSPACE_INSTRUCTIONS = 'The target repository is mounted read-only at /repo. Mutable release artifacts are confined to /output. Search /repo before reading whole files. Never copy secrets, .env files, credentials, or private keys into /output.';

const SAFE_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);
const PRIVATE_DIRECTORIES = new Set(['.git', '.ssh', '.aws', '.gcloud']);
const PRIVATE_FILES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'credentials.json',
  'service-account.json',
]);

function isPrivatePath(path: string): boolean {
  return normalizePath(path).split('/').filter(Boolean).some((segment) => {
    const name = segment.toLowerCase();
    if (PRIVATE_DIRECTORIES.has(name) || PRIVATE_FILES.has(name)) return true;
    if (name.startsWith('.env') && !SAFE_ENV_TEMPLATES.has(name)) return true;
    if (/^(?:id_rsa|id_ed25519)(?:\.|$)/.test(name)) return true;
    return /\.(?:key|pem|p12|pfx|secret|secrets)$/.test(name);
  });
}

function denied(path: string): Error {
  return Object.assign(new Error(`EACCES: private repository path is not available to the agent, read '${path}'`), {
    code: 'EACCES',
  });
}

/** Immutable repository view that also removes credential-bearing paths from model visibility. */
export class ReleaseRepositoryFileSystem extends ReadOnlyFileSystem {
  constructor(source: FileSystem) {
    super(source);
  }

  private assertPath(path: string): void {
    if (isPrivatePath(path)) throw denied(path);
  }

  private async assertReadable(path: string): Promise<void> {
    this.assertPath(path);
    this.assertPath(await this.source.realpath(path));
  }

  override async readFile(path: string): Promise<string> {
    await this.assertReadable(path);
    return this.source.readFile(path);
  }

  override async readFileBytes(path: string): Promise<Uint8Array> {
    await this.assertReadable(path);
    return this.source.readFileBytes(path);
  }

  override async exists(path: string): Promise<boolean> {
    try {
      await this.assertReadable(path);
      return this.source.exists(path);
    } catch {
      return false;
    }
  }

  override async stat(path: string): Promise<FsStat> {
    await this.assertReadable(path);
    return this.source.stat(path);
  }

  override async lstat(path: string): Promise<FsStat> {
    await this.assertReadable(path);
    return this.source.lstat(path);
  }

  override async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map((entry) => entry.name);
  }

  override async readdirWithFileTypes(path: string): Promise<FileSystemDirent[]> {
    await this.assertReadable(path);
    const visible: FileSystemDirent[] = [];
    for (const entry of await this.source.readdirWithFileTypes(path)) {
      const child = this.resolvePath(path, entry.name);
      if (isPrivatePath(child)) continue;
      if (entry.type === 'symlink' && !await this.exists(child)) continue;
      visible.push(entry);
    }
    return visible;
  }

  override async readlink(path: string): Promise<string> {
    await this.assertReadable(path);
    return this.source.readlink(path);
  }

  override async realpath(path: string): Promise<string> {
    await this.assertReadable(path);
    return this.source.realpath(path);
  }

  override async glob(pattern: string): Promise<string[]> {
    const matcher = createGlobMatcher(pattern);
    const hits: string[] = [];
    const stack = ['/'];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of await this.readdirWithFileTypes(current)) {
        const child = this.resolvePath(current, entry.name);
        if (matcher.test(child)) hits.push(child);
        if (entry.type === 'directory') stack.push(child);
      }
    }
    return sortPaths(hits);
  }
}

export function createReleaseWorkspace(config: ReleaseAgentConfig): CompositeFileSystem {
  return new CompositeFileSystem({
    mounts: {
      '/repo': new ReleaseRepositoryFileSystem(nodeFileSystem(config.repoRoot)),
      '/output': nodeFileSystem(config.stateRoot),
    },
  });
}

export function createReleaseSkillStore(skillRoot: string): SkillStoreLike {
  return fsSkillStore(readOnlyFileSystem(nodeFileSystem(skillRoot)), ['/skills']);
}
