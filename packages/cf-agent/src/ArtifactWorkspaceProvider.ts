import type { FileSystem } from '@kuralle-agents/core';
import {
  CompositeFileSystem,
  InMemoryFs,
  readOnlyFileSystem,
  sqlFileSystem,
  type BlobStore,
  type InitialFiles,
} from '@kuralle-agents/fs';
import {
  DeploymentError,
  canonicalJson,
  type ArtifactWorkspaceContext,
  type ArtifactWorkspaceProvider,
} from '@kuralle-agents/deployment';
import type { DurableSqlStorage } from './types.js';

interface WorkspaceManifest {
  schemaVersion: 1;
  tenantId: string;
  threadId: string;
  agentId: string;
  artifactDigest: string;
}

export interface FileSystemArtifactWorkspaceOptions {
  /** Mutable filesystem private to one Durable Object instance. */
  data: FileSystem;
  /** Private filesystem for the seed/pin marker; it is never mounted for the agent. */
  metadata: FileSystem;
  modelWritable?: boolean;
}

export interface DurableObjectArtifactWorkspaceOptions {
  sql: DurableSqlStorage;
  /** Optional R2 adapter for mutable files larger than the SQL inline threshold. */
  blobs?: BlobStore;
  modelWritable?: boolean;
  inlineThreshold?: number;
}

function stripRoot(path: string, root: 'references' | 'workspace'): string {
  const prefix = `${root}/`;
  if (!path.startsWith(prefix) || path.length === prefix.length) {
    throw new DeploymentError('CONTENT_INVALID', `${path} is not under ${root}/`, path);
  }
  return `/${path.slice(prefix.length)}`;
}

function manifest(context: ArtifactWorkspaceContext): WorkspaceManifest {
  return {
    schemaVersion: 1,
    tenantId: context.pin.tenantId,
    threadId: context.pin.threadId,
    agentId: context.artifact.agent.id,
    artifactDigest: context.artifact.digest,
  };
}

async function ensureParent(fs: FileSystem, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return;
  await fs.mkdir(path.slice(0, slash), { recursive: true });
}

function referenceFileSystem(context: ArtifactWorkspaceContext): InMemoryFs {
  const files: InitialFiles = {};
  for (const entry of context.references) {
    files[stripRoot(entry.path, 'references')] = () => context.read(entry);
  }
  return new InMemoryFs(files);
}

/**
 * Compose a Durable Object workspace from two isolated filesystems. The marker
 * lives outside the model-visible mount, and seed completion is awaited before
 * the first turn can start.
 */
export function fileSystemArtifactWorkspaceProvider(
  options: FileSystemArtifactWorkspaceOptions,
): ArtifactWorkspaceProvider {
  let initialized: Promise<void> | undefined;
  let identity: string | undefined;

  return {
    async open(context) {
      const expected = canonicalJson(manifest(context));
      if (identity !== undefined && identity !== expected) {
        throw new DeploymentError('ACCESS_DENIED', 'Durable Object workspace was reused for a different thread pin');
      }
      identity = expected;
      initialized ??= (async () => {
        const marker = '/workspace-manifest.json';
        if (await options.metadata.exists(marker)) {
          if ((await options.metadata.readFile(marker)).trim() !== expected) {
            throw new DeploymentError('ACCESS_DENIED', 'workspace identity does not match the pinned thread');
          }
          return;
        }
        for (const entry of context.workspaceSeed) {
          const path = stripRoot(entry.path, 'workspace');
          await ensureParent(options.data, path);
          await options.data.writeFileBytes(path, await context.read(entry));
        }
        await options.metadata.writeFile(marker, `${expected}\n`);
      })();
      await initialized;

      return {
        fs: new CompositeFileSystem({
          mounts: {
            '/references': readOnlyFileSystem(referenceFileSystem(context)),
            '/workspace': options.data,
          },
        }),
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

/** Production workspace provider for one generic KuralleThreadAgent instance. */
export function durableObjectArtifactWorkspaceProvider(
  options: DurableObjectArtifactWorkspaceOptions,
): ArtifactWorkspaceProvider {
  return fileSystemArtifactWorkspaceProvider({
    data: sqlFileSystem(options.sql, {
      namespace: 'kuralle_workspace',
      blobs: options.blobs,
      inlineThreshold: options.inlineThreshold,
    }),
    metadata: sqlFileSystem(options.sql, { namespace: 'kuralle_workspace_meta' }),
    modelWritable: options.modelWritable,
  });
}
