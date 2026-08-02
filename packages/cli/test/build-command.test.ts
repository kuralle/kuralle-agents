import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

  it('emits the bytes behind content-addressed blob references', async () => {
    const agent = await mkdtemp(join(tmpdir(), 'kuralle-cli-blob-agent-'));
    const out = await mkdtemp(join(tmpdir(), 'kuralle-cli-blob-build-'));
    await mkdir(join(agent, 'references'));
    await writeFile(join(agent, 'instructions.md'), 'Inspect the diagram.');
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(join(agent, 'references/diagram.png'), image);

    const result = await runBuildCommand([
      '--agent', agent, '--out', out, '--target', 'node',
      '--default-model', 'openai/gpt-5-mini',
    ]);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      blobs: Array<{ file: string; digest: string }>;
    };
    expect(manifest.blobs).toHaveLength(1);
    expect(new Uint8Array(await readFile(join(out, manifest.blobs[0]!.file)))).toEqual(image);
  });

  it('requires a concrete D1 database before emitting a Cloudflare deployment', async () => {
    await expect(runBuildCommand([
      '--agent', join(import.meta.dir, '../../build/test/fixtures/support'),
      '--out', join(tmpdir(), 'unused-kuralle-build'),
      '--target', 'cloudflare',
      '--default-model', 'openai/gpt-5-mini',
      '--host', 'deployment.node.ts',
    ])).rejects.toThrow('--d1-id is required');
  });

  it('bundles a self-contained Node server and production Dockerfile', async () => {
    const out = await mkdtemp(join(tmpdir(), 'kuralle-cli-host-build-'));
    const example = resolve(import.meta.dir, '../../../apps/examples/file-agent-chat');

    const result = await runBuildCommand([
      '--agent', join(example, 'agent'),
      '--out', out,
      '--target', 'node',
      '--default-model', 'openai/gpt-4.1-mini',
      '--host', join(example, 'deployment.node.ts'),
    ]);

    expect(result.serverPath).toBe(join(out, 'node/server.mjs'));
    expect((await readFile(result.serverPath!, 'utf8')).length).toBeGreaterThan(10_000);
    const dockerfile = await readFile(join(out, 'node/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
    const artifact = JSON.parse(await readFile(join(out, 'artifacts/agent.agent.json'), 'utf8')) as {
      agent: { model: string };
      references: unknown[];
      skills: unknown[];
      workspaceSeed: unknown[];
    };
    expect(artifact.agent.model).toBe('openai/gpt-4.1-mini');
    expect(artifact.references).toHaveLength(1);
    expect(artifact.skills).toHaveLength(1);
    expect(artifact.workspaceSeed).toHaveLength(1);
  });

  it('bundles a Cloudflare Worker with a declarative SQLite DO, D1, R2, and observability config', async () => {
    const out = await mkdtemp(join(tmpdir(), 'kuralle-cli-cf-build-'));
    const host = join(import.meta.dir, 'fixtures/cloudflare-host.ts');

    const result = await runBuildCommand([
      '--agent', join(import.meta.dir, '../../build/test/fixtures/support'),
      '--out', out,
      '--target', 'cloudflare',
      '--default-model', 'openai/gpt-5-mini',
      '--host', host,
      '--name', 'support-agent',
      '--d1-id', '00000000-0000-0000-0000-000000000001',
      '--d1-name', 'support-control',
      '--r2-bucket', 'support-blobs',
    ]);

    expect(result.workerPath).toBe(join(out, 'cloudflare/worker.mjs'));
    expect((await readFile(result.workerPath!, 'utf8')).length).toBeGreaterThan(1_000);
    const wrangler = JSON.parse(await readFile(join(out, 'cloudflare/wrangler.jsonc'), 'utf8'));
    expect(wrangler.durable_objects.bindings[0].class_name).toBe('KuralleThread');
    expect(wrangler.exports.KuralleThread).toEqual({ type: 'durable-object', storage: 'sqlite' });
    expect(wrangler.migrations).toBeUndefined();
    expect(wrangler.d1_databases[0].database_name).toBe('support-control');
    expect(wrangler.r2_buckets[0].bucket_name).toBe('support-blobs');
    expect(wrangler.observability.enabled).toBe(true);
  });
});
