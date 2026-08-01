/// <reference types="node" />

import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  CompositeFileSystem,
  InMemoryFs,
  readOnlyFileSystem,
  type InitialFiles,
} from '@kuralle-agents/fs';
import { NodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { canonicalJson, sha256 } from './canonical.js';
import { DeploymentError } from './errors.js';
import type {
  ArtifactWorkspaceContext,
  ArtifactWorkspaceProvider,
} from './binder.js';

interface WorkspaceManifest {
  schemaVersion: 1;
  tenantId: string;
  threadId: string;
  agentId: string;
  artifactDigest: string;
}

export interface NodeArtifactWorkspaceOptions {
  /** Root of a persistent, shared POSIX volume. Each pin receives a hashed child directory. */
  root: string;
  /** Expose write operations to the model-facing workspace tool. Defaults to false. */
  modelWritable?: boolean;
}

function stripRoot(path: string, root: 'references' | 'workspace'): string {
  const prefix = `${root}/`;
  if (!path.startsWith(prefix) || path.length === prefix.length) {
    throw new DeploymentError('CONTENT_INVALID', `${path} is not under ${root}/`, path);
  }
  return path.slice(prefix.length);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function targetPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  if (!isWithin(root, target)) {
    throw new DeploymentError('CONTENT_INVALID', `workspace path escapes its root: ${relativePath}`);
  }
  return target;
}

function expectedManifest(context: ArtifactWorkspaceContext): WorkspaceManifest {
  return {
    schemaVersion: 1,
    tenantId: context.pin.tenantId,
    threadId: context.pin.threadId,
    agentId: context.artifact.agent.id,
    artifactDigest: context.artifact.digest,
  };
}

async function assertManifest(path: string, expected: WorkspaceManifest): Promise<void> {
  let actual: unknown;
  try {
    actual = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new DeploymentError(
      'BINDING_FAILED',
      `workspace manifest is missing or invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new DeploymentError('ACCESS_DENIED', 'workspace identity does not match the pinned thread');
  }
}

async function initializeWorkspace(
  scopeDir: string,
  context: ArtifactWorkspaceContext,
): Promise<void> {
  const manifest = expectedManifest(context);
  const manifestPath = join(scopeDir, 'manifest.json');
  try {
    await assertManifest(manifestPath, manifest);
    return;
  } catch (error) {
    if (!(error instanceof DeploymentError) || error.code !== 'BINDING_FAILED') throw error;
  }

  const parent = dirname(scopeDir);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.workspace-${crypto.randomUUID()}.tmp`);
  const dataRoot = join(temporary, 'data');
  try {
    await mkdir(dataRoot, { recursive: true });
    for (const entry of context.workspaceSeed) {
      const output = targetPath(dataRoot, stripRoot(entry.path, 'workspace'));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, await context.read(entry));
    }
    await writeFile(join(temporary, 'manifest.json'), `${canonicalJson(manifest)}\n`, 'utf8');
    try {
      await rename(temporary, scopeDir);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await assertManifest(manifestPath, manifest);
}

function referenceFileSystem(context: ArtifactWorkspaceContext): InMemoryFs {
  const files: InitialFiles = {};
  for (const entry of context.references) {
    files[`/${stripRoot(entry.path, 'references')}`] = () => context.read(entry);
  }
  return new InMemoryFs(files);
}

/**
 * Production Node workspace provider backed by a caller-owned persistent volume.
 * Initialization is an atomic directory rename, so concurrent replicas cannot
 * expose a partially seeded workspace. Mount the configured root into every
 * replica when using the distributed HTTP router.
 */
export function nodeArtifactWorkspaceProvider(
  options: NodeArtifactWorkspaceOptions,
): ArtifactWorkspaceProvider {
  const root = resolve(options.root);
  return {
    async open(context) {
      const scopeDigest = await sha256(canonicalJson({
        tenantId: context.pin.tenantId,
        threadId: context.pin.threadId,
        agentId: context.artifact.agent.id,
      }));
      const scopeDir = join(root, scopeDigest.slice(0, 2), scopeDigest);
      await initializeWorkspace(scopeDir, context);

      const mounts = {
        '/references': readOnlyFileSystem(referenceFileSystem(context)),
        '/workspace': new NodeFileSystem(join(scopeDir, 'data')),
      };
      return {
        fs: new CompositeFileSystem({ mounts }),
        readOnly: false,
        modelWritable: options.modelWritable === true,
        instructions: [
          'Revision references are mounted read-only at /references.',
          'Thread-private mutable files are mounted at /workspace.',
        ].join(' '),
      };
    },
  };
}
