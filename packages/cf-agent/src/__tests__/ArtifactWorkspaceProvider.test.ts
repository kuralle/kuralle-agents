import { describe, expect, it } from 'bun:test';
import { InMemoryFs } from '@kuralle-agents/fs';
import {
  createArtifact,
  sha256,
  type ArtifactWorkspaceContext,
  type ThreadPin,
} from '@kuralle-agents/deployment';
import { fileSystemArtifactWorkspaceProvider } from '../ArtifactWorkspaceProvider.js';

describe('Durable Object artifact workspace provider', () => {
  it('seeds once, keeps metadata private, and rejects reuse across thread pins', async () => {
    const reference = 'Policy text';
    const seed = 'Initial draft';
    const instructions = 'Help the user.';
    const artifact = await createArtifact({
      schemaVersion: 1, artifactId: 'support', compiler: { name: 'kuralle', version: '0.19.0' },
      runtimeApiRange: '^1.0.0',
      agent: { id: 'support', model: 'openai/gpt-5-mini' },
      instructions: [{
        path: 'instructions.md', digest: await sha256(instructions), bytes: instructions.length,
        mediaType: 'text/markdown', role: 'instructions', content: { kind: 'inline', text: instructions },
      }],
      skills: [], agents: [], tools: [], flows: [], policies: {},
      requiredCapabilities: [], secretRefs: [], sourceMap: [],
      references: [{
        path: 'references/policy.md', digest: await sha256(reference), bytes: reference.length,
        mediaType: 'text/markdown', role: 'reference', content: { kind: 'inline', text: reference },
      }],
      workspaceSeed: [{
        path: 'workspace/draft.md', digest: await sha256(seed), bytes: seed.length,
        mediaType: 'text/markdown', role: 'workspace-seed', content: { kind: 'inline', text: seed },
      }],
    });
    const data = new InMemoryFs();
    const metadata = new InMemoryFs();
    const provider = fileSystemArtifactWorkspaceProvider({ data, metadata, modelWritable: true });
    const pin: ThreadPin = {
      tenantId: 'tenant-a', threadId: 'thread-a', agentEntityId: 'support', agentVersionId: 'v1',
      artifactDigest: artifact.digest, runtimeRevisionId: 'runtime-1', releaseId: 'release-1',
      environment: 'production', configGeneration: 1, secretGeneration: 1,
      assignedAt: '2026-08-01T00:00:00.000Z',
    };
    const context: ArtifactWorkspaceContext = {
      pin, artifact, session: { id: 'thread-a' } as never,
      references: artifact.references, workspaceSeed: artifact.workspaceSeed,
      read: async entry => new TextEncoder().encode(
        entry.content.kind === 'inline' ? entry.content.text : '',
      ),
    };

    const first = await provider.open(context);
    const fs = (first as { fs: InMemoryFs }).fs;
    expect(await fs.readFile('/references/policy.md')).toBe(reference);
    await expect(fs.writeFile('/references/policy.md', 'changed')).rejects.toThrow('EROFS');
    expect(await fs.readFile('/workspace/draft.md')).toBe(seed);
    expect(await fs.exists('/workspace-manifest.json')).toBe(false);
    await fs.writeFile('/workspace/draft.md', 'changed');

    const reopened = await provider.open(context) as { fs: InMemoryFs };
    expect(await reopened.fs.readFile('/workspace/draft.md')).toBe('changed');
    await expect(provider.open({
      ...context,
      pin: { ...pin, threadId: 'thread-b' },
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });
});
