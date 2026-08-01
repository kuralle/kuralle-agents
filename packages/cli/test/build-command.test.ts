import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBuildCommand } from '../src/buildCommand.js';

describe('kuralle build', () => {
  it('emits canonical artifacts, a manifest, and static capability imports', async () => {
    const out = await mkdtemp(join(tmpdir(), 'kuralle-cli-build-'));
    const agent = join(import.meta.dir, '../../build/test/fixtures/support');
    const result = await runBuildCommand([
      '--agent', agent,
      '--out', out,
      '--target', 'node',
      '--default-model', 'openai/gpt-5-mini',
      '--artifact-prefix', 'cli-test',
    ]);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      rootArtifactDigest: string;
      artifacts: Array<{ file: string }>;
      capabilitiesSource: string;
    };
    expect(manifest.rootArtifactDigest).toBe(result.artifactDigest);
    expect(manifest.artifacts).toHaveLength(2);
    expect(await readFile(join(out, manifest.capabilitiesSource), 'utf8')).toContain(
      'registerGeneratedCapabilities',
    );
    for (const entry of manifest.artifacts) {
      const artifact = JSON.parse(await readFile(join(out, entry.file), 'utf8')) as { digest: string };
      expect(artifact.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(result.serverPath).toBeUndefined();
  });

  it('does not pretend a Node host factory can be bundled for Cloudflare', async () => {
    await expect(runBuildCommand([
      '--agent', join(import.meta.dir, '../../build/test/fixtures/support'),
      '--out', join(tmpdir(), 'unused-kuralle-build'),
      '--target', 'cloudflare',
      '--default-model', 'openai/gpt-5-mini',
      '--host', 'deployment.node.ts',
    ])).rejects.toThrow('Cloudflare uses the emitted static sources with Wrangler');
  });

  it('bundles a self-contained Node server and production Dockerfile', async () => {
    const out = await mkdtemp(join(tmpdir(), 'kuralle-cli-host-build-'));
    const host = join(out, 'deployment.node.ts');
    await writeFile(host, [
      'export default async function createHost() {',
      "  throw new Error('host is not executed while bundling');",
      '}',
      '',
    ].join('\n'), 'utf8');

    const result = await runBuildCommand([
      '--agent', join(import.meta.dir, '../../build/test/fixtures/support'),
      '--out', out,
      '--target', 'node',
      '--default-model', 'openai/gpt-5-mini',
      '--host', host,
    ]);

    expect(result.serverPath).toBe(join(out, 'node/server.mjs'));
    expect((await readFile(result.serverPath!, 'utf8')).length).toBeGreaterThan(10_000);
    const dockerfile = await readFile(join(out, 'node/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
  });
});
