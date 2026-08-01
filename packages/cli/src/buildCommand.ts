import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as bundle } from 'esbuild';
import {
  compileAgentDirectory,
  generateCapabilityRegistrySource,
  type BuildTarget,
} from '@kuralle-agents/build';
import { canonicalJson, sha256 } from '@kuralle-agents/deployment';

const NODE_DOCKERFILE = `FROM node:22.18.0-bookworm-slim

ENV NODE_ENV=production \\
    PORT=3000
WORKDIR /app
COPY --chown=node:node server.mjs /app/server.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
`;

const CLI_NODE_MODULES = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules');

export interface BuildCommandResult {
  outDir: string;
  manifestPath: string;
  serverPath?: string;
  workerPath?: string;
  artifactDigest: string;
  runtimeRevisionSeed: string;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function targetFrom(value: string | undefined): BuildTarget {
  if (value === undefined || value === 'node') return 'node';
  if (value === 'cloudflare') return 'cloudflare';
  throw new Error(`--target must be node or cloudflare, received ${value}`);
}

export async function runBuildCommand(args: string[]): Promise<BuildCommandResult> {
  const agentDirectory = resolve(option(args, '--agent') ?? 'agent');
  const outDir = resolve(option(args, '--out') ?? '.kuralle');
  const target = targetFrom(option(args, '--target'));
  const defaultModel = option(args, '--default-model');
  if (!defaultModel) throw new Error('--default-model is required');
  const compilerVersion = option(args, '--compiler-version') ?? '0.19.0';
  const runtimeApiRange = option(args, '--runtime-api-range') ?? '^1.0.0';
  const artifactIdPrefix = option(args, '--artifact-prefix') ?? 'agent';
  const host = option(args, '--host');
  const d1DatabaseId = option(args, '--d1-id');
  if (target === 'cloudflare' && host && !d1DatabaseId) {
    throw new Error('--d1-id is required when bundling a Cloudflare deployment');
  }

  const generatedSource = join(outDir, 'generated', 'capabilities.ts');
  const project = await compileAgentDirectory(agentDirectory, {
    defaultModel,
    compilerVersion,
    runtimeApiRange,
    target,
    artifactIdPrefix,
  });
  await mkdir(dirname(generatedSource), { recursive: true });
  await mkdir(join(outDir, 'artifacts'), { recursive: true });
  await mkdir(join(outDir, 'blobs'), { recursive: true });
  await writeFile(
    generatedSource,
    generateCapabilityRegistrySource(project, {
      generatedFile: generatedSource,
      importMode: 'absolute',
    }),
    'utf8',
  );
  for (const artifact of project.artifacts) {
    await writeFile(
      join(outDir, 'artifacts', `${encodeURIComponent(artifact.artifactId)}.json`),
      `${canonicalJson(artifact)}\n`,
      'utf8',
    );
  }
  const artifactBlobs: Record<string, string> = {};
  for (const blob of project.blobs) {
    const data = await readFile(blob.sourcePath);
    await writeFile(join(outDir, 'blobs', blob.digest), data);
    artifactBlobs[`sha256:${blob.digest}`] = data.toString('base64');
  }
  const runtimeRevisionSeed = await sha256(canonicalJson(project.modules.map(module => ({
    capability: module.capability,
    version: module.version,
    digest: module.digest,
  }))));
  const manifest = {
    schemaVersion: 1,
    target,
    rootArtifactId: project.rootArtifact.artifactId,
    rootArtifactDigest: project.rootArtifact.digest,
    artifacts: project.artifacts.map(artifact => ({
      artifactId: artifact.artifactId,
      digest: artifact.digest,
      file: `artifacts/${encodeURIComponent(artifact.artifactId)}.json`,
    })),
    blobs: project.blobs.map(blob => ({
      digest: blob.digest,
      bytes: blob.bytes,
      mediaType: blob.mediaType,
      file: `blobs/${blob.digest}`,
    })),
    runtimeRevisionSeed,
    capabilitiesSource: 'generated/capabilities.ts',
  };
  const manifestPath = join(outDir, 'manifest.json');
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`, 'utf8');

  let serverPath: string | undefined;
  let workerPath: string | undefined;
  if (host) {
    const artifactsSource = join(outDir, 'generated', 'artifacts.ts');
    await writeFile(artifactsSource, [
      `export const artifacts = ${canonicalJson(project.artifacts)};`,
      `export const rootArtifactDigest = ${JSON.stringify(project.rootArtifact.digest)};`,
      `export const runtimeRevisionSeed = ${JSON.stringify(runtimeRevisionSeed)};`,
      `export const artifactBlobs = ${canonicalJson(artifactBlobs)};`,
      '',
    ].join('\n'), 'utf8');
    const hostSpecifier = resolve(host).split('\\').join('/');

    if (target === 'node') {
      const nodeDir = join(outDir, 'node');
      const entry = join(outDir, 'generated', 'node-entry.ts');
      await mkdir(nodeDir, { recursive: true });
      await writeFile(entry, [
        `import createHost from ${JSON.stringify(hostSpecifier)};`,
        `import { createDeploymentRouter } from '@kuralle-agents/hono-server';`,
        `import { startDeploymentServer } from '@kuralle-agents/hono-server/node';`,
        `import { artifactBlobs, artifacts, rootArtifactDigest, runtimeRevisionSeed } from './artifacts.js';`,
        `import { registerGeneratedCapabilities, runtimeCapabilities } from './capabilities.js';`,
        '',
        'const options = await createHost({ artifactBlobs, artifacts, rootArtifactDigest, runtimeRevisionSeed, runtimeCapabilities });',
        'registerGeneratedCapabilities(options.bindings);',
        'const app = createDeploymentRouter(options);',
        'const port = Number(process.env.PORT ?? 3000);',
        'startDeploymentServer({ app, port, installSignalHandlers: true });',
        '',
      ].join('\n'), 'utf8');
      serverPath = join(nodeDir, 'server.mjs');
      await bundle({
        entryPoints: [entry], outfile: serverPath, bundle: true, platform: 'node',
        target: 'node22', format: 'esm', sourcemap: false, minify: false,
        legalComments: 'none', logLevel: 'silent', nodePaths: [CLI_NODE_MODULES],
      });
      await writeFile(join(nodeDir, 'Dockerfile'), NODE_DOCKERFILE, 'utf8');
    } else {
      const cloudflareDir = join(outDir, 'cloudflare');
      const entry = join(outDir, 'generated', 'cloudflare-entry.ts');
      await mkdir(cloudflareDir, { recursive: true });
      await writeFile(entry, [
        `import createHost from ${JSON.stringify(hostSpecifier)};`,
        `import { artifactBlobs, artifacts, rootArtifactDigest, runtimeRevisionSeed } from './artifacts.js';`,
        `import { registerGeneratedCapabilities, runtimeCapabilities } from './capabilities.js';`,
        '',
        'const deployment = await createHost({',
        '  artifactBlobs, artifacts, rootArtifactDigest, runtimeRevisionSeed, runtimeCapabilities,',
        '  registerGeneratedCapabilities,',
        '});',
        'export const KuralleThread = deployment.agent;',
        'export default deployment.worker;',
        '',
      ].join('\n'), 'utf8');
      workerPath = join(cloudflareDir, 'worker.mjs');
      await bundle({
        entryPoints: [entry], outfile: workerPath, bundle: true, platform: 'browser',
        target: 'es2022', format: 'esm', sourcemap: false, minify: false,
        legalComments: 'none', logLevel: 'silent', nodePaths: [CLI_NODE_MODULES],
        conditions: ['workerd', 'worker', 'browser'],
        external: ['cloudflare:*', 'node:*', ...builtinModules],
      });
      const appName = option(args, '--name') ?? 'kuralle-agent';
      const d1DatabaseName = option(args, '--d1-name') ?? `${appName}-control`;
      const r2Bucket = option(args, '--r2-bucket');
      const wrangler = {
        name: appName,
        main: 'worker.mjs',
        compatibility_date: '2026-07-29',
        compatibility_flags: [
          'nodejs_compat',
          'enable_nodejs_tty_module',
          'enable_nodejs_fs_module',
          'enable_nodejs_http_modules',
          'enable_nodejs_perf_hooks_module',
          'enable_nodejs_v8_module',
          'enable_nodejs_process_v2',
        ],
        durable_objects: {
          bindings: [{ name: 'KURALLE_THREADS', class_name: 'KuralleThread' }],
        },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['KuralleThread'] }],
        d1_databases: [{
          binding: 'KURALLE_CONTROL', database_name: d1DatabaseName, database_id: d1DatabaseId!,
        }],
        ...(r2Bucket ? { r2_buckets: [{ binding: 'KURALLE_BLOBS', bucket_name: r2Bucket }] } : {}),
        observability: { enabled: true },
      };
      await writeFile(
        join(cloudflareDir, 'wrangler.jsonc'),
        `${JSON.stringify(wrangler, null, 2)}\n`,
        'utf8',
      );
    }
  }

  return {
    outDir,
    manifestPath,
    serverPath,
    workerPath,
    artifactDigest: project.rootArtifact.digest,
    runtimeRevisionSeed,
  };
}

export async function runStartCommand(args: string[]): Promise<void> {
  const appPath = resolve(option(args, '--app') ?? '.kuralle/node/server.mjs');
  await readFile(appPath);
  await import(pathToFileURL(appPath).href);
}
