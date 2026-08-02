import { createRequire } from 'node:module';
import { createArtifact, sha256 } from '../packages/deployment/src/index.ts';
import { PostgresDeploymentStore } from '../packages/postgres-store/src/PostgresDeploymentStore.ts';

const projectId = process.argv[2];
const requireFromPostgresPackage = createRequire(
  new URL('../packages/postgres-store/package.json', import.meta.url),
);
const { Pool } = requireFromPostgresPackage('pg') as typeof import('pg');
if (!projectId) throw new Error('Usage: bun scripts/neon-deployment-store-smoke.ts <disposable-project-id>');

async function neon(...args: string[]): Promise<string> {
  const process = Bun.spawn(['neonctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`neonctl failed: ${stderr.trim()}`);
  return stdout.trim();
}

const project = JSON.parse(await neon('projects', 'get', projectId, '--output', 'json')) as {
  project?: { id?: string; name?: string };
  id?: string;
  name?: string;
};
const identity = project.project ?? project;
if (identity.id !== projectId || !identity.name?.startsWith('kuralle-validation-')) {
  throw new Error('Refusing to mutate a Neon project that is not an explicit Kuralle validation project');
}

const connectionString = (await neon(
  'connection-string',
  '--project-id', projectId,
  '--database-name', 'kuralle_validation',
  '--role-name', 'kuralle_validation_owner',
)).replace('sslmode=require', 'sslmode=verify-full');
const pool = new Pool({ connectionString, max: 2 });
const schema = 'kuralle_validation';
const at = new Date().toISOString();

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const store = new PostgresDeploymentStore({ client: pool, schema });
  await store.migrate();
  const instructions = 'Reply with the word verified.';
  const artifact = await createArtifact({
    schemaVersion: 1,
    artifactId: 'neon-live-v1',
    compiler: { name: 'kuralle', version: '0.19.0' },
    runtimeApiRange: '^1.0.0',
    agent: { id: 'neon-live', model: 'openai/gpt-4.1-mini' },
    instructions: [{
      path: 'instructions.md',
      digest: await sha256(instructions),
      bytes: new TextEncoder().encode(instructions).byteLength,
      mediaType: 'text/markdown',
      role: 'instructions',
      content: { kind: 'inline', text: instructions },
    }],
    skills: [], references: [], workspaceSeed: [], agents: [], tools: [], flows: [],
    policies: {}, requiredCapabilities: [], secretRefs: [], sourceMap: [],
  });
  await store.createEntity({
    id: 'neon-live', tenantId: 'validation', slug: 'neon-live', status: 'active',
    ownerId: 'validation', visibility: 'private', createdAt: at,
  });
  await store.createVersion({
    id: 'neon-live-v1', tenantId: 'validation', agentEntityId: 'neon-live', version: 1,
    artifact, createdBy: 'validation', createdAt: at,
  });
  await store.registerRuntime({
    id: 'runtime-live-v1', artifactSchemaVersions: [1], runtimeApiVersion: '1.0.0',
    capabilities: [], createdAt: at,
  });
  await store.createRelease({
    id: 'release-live-v1', tenantId: 'validation', agentEntityId: 'neon-live',
    environment: 'production',
    allocations: [{ agentVersionId: 'neon-live-v1', runtimeRevisionId: 'runtime-live-v1', weight: 10_000 }],
    createdAt: at,
  });
  await store.routeTrafficTo('validation', 'release-live-v1');
  const pin = await store.assignThread({
    tenantId: 'validation', threadId: 'thread-live', agentEntityId: 'neon-live',
    environment: 'production', assignedAt: at,
  });
  const version = await store.getVersion('validation', pin.agentVersionId);
  if (!version || version.artifact.digest !== pin.artifactDigest) {
    throw new Error('Neon returned a version that does not match its durable thread pin');
  }
  const tables = await pool.query(
    'SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = $1',
    [schema],
  );
  console.log(JSON.stringify({
    projectId,
    projectName: identity.name,
    schema,
    deploymentTables: Number(tables.rows[0]?.count ?? 0),
    agentVersionId: pin.agentVersionId,
    digestVerified: true,
  }, null, 2));
} finally {
  await pool.end();
}
