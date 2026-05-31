/**
 * Bundle the monorepo's apps/templates/* into this package's templates/ dir so they
 * ship inside the published npm tarball (create-vite pattern — no git fetch at runtime).
 *
 * For each template we:
 *   - skip cruft (node_modules, .next, dist, lockfiles, .env, .git, .turbo)
 *   - rewrite `workspace:*` deps on published @kuralle-agents/* packages to a real range
 *   - SKIP (with a log line) any template that depends on a private/internal workspace
 *     package (e.g. @kuralle-templates/_shared-*), which can't be installed standalone
 *
 * Run via `npm run sync-templates` (and automatically at prepublishOnly).
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const templatesSrc = join(repoRoot, 'apps', 'templates');
const templatesOut = join(pkgRoot, 'templates');

// The version published @kuralle-agents/* deps should resolve to (the fixed monorepo version).
const coreVersion = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'kuralle-core', 'package.json'), 'utf8'),
).version as string;
const ariaRange = `^${coreVersion}`;

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', '.git', 'out']);
const SKIP_FILES = new Set(['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', '.env', 'tsconfig.tsbuildinfo']);

type ManifestEntry = { id: string; title: string; description: string };

function isWorkspaceDep(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('workspace:');
}

/** A template is bundleable only if every workspace dep is a published @kuralle-agents/* package. */
function classify(pkgJson: Record<string, unknown>): { clean: boolean; reason?: string } {
  const all: Record<string, string> = {
    ...(pkgJson.dependencies as Record<string, string> ?? {}),
    ...(pkgJson.devDependencies as Record<string, string> ?? {}),
  };
  for (const [name, version] of Object.entries(all)) {
    if (isWorkspaceDep(version) && !name.startsWith('@kuralle-agents/')) {
      return { clean: false, reason: `depends on unpublished workspace package ${name}` };
    }
  }
  return { clean: true };
}

/** Rewrite workspace:* @kuralle-agents/* deps to the published range; set the project name. */
function sanitizePkgJson(raw: string, projectName: string): string {
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg.name = projectName;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (isWorkspaceDep(version) && name.startsWith('@kuralle-agents/')) {
        deps[name] = ariaRange;
      }
    }
  }
  return JSON.stringify(pkg, null, 2) + '\n';
}

function copyTemplate(srcDir: string, outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(srcDir, outDir, {
    recursive: true,
    filter: (src) => {
      const base = src.slice(srcDir.length + 1).split('/')[0] || '';
      const name = src.split('/').pop() || '';
      if (SKIP_DIRS.has(base) || SKIP_DIRS.has(name)) return false;
      if (SKIP_FILES.has(name)) return false;
      // Never bundle real env files — only the .env.example template. (.env.local etc. hold secrets.)
      if (name.startsWith('.env') && name !== '.env.example') return false;
      return true;
    },
  });
  // Sanitize the copied package.json (keep the template's own name as the default project name).
  const outPkgPath = join(outDir, 'package.json');
  if (existsSync(outPkgPath)) {
    const pkg = JSON.parse(readFileSync(outPkgPath, 'utf8')) as { name?: string };
    writeFileSync(outPkgPath, sanitizePkgJson(readFileSync(outPkgPath, 'utf8'), pkg.name ?? 'kuralle-app'));
  }
  // Ship a gitignore for the scaffolded project (npm strips a real .gitignore from tarballs,
  // so templates store it as _gitignore and the CLI renames it on copy).
  const gi = join(outDir, '.gitignore');
  if (existsSync(gi)) {
    cpSync(gi, join(outDir, '_gitignore'));
    rmSync(gi);
  }
}

function main(): void {
  rmSync(templatesOut, { recursive: true, force: true });
  mkdirSync(templatesOut, { recursive: true });

  const entries = readdirSync(templatesSrc).filter((d) => {
    if (d.startsWith('_')) return false; // _shared
    const p = join(templatesSrc, d);
    return statSync(p).isDirectory() && existsSync(join(p, 'package.json'));
  });

  const manifest: ManifestEntry[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of entries) {
    const srcDir = join(templatesSrc, id);
    const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    const verdict = classify(pkg);
    if (!verdict.clean) {
      skipped.push({ id, reason: verdict.reason! });
      continue;
    }
    copyTemplate(srcDir, join(templatesOut, id));
    manifest.push({
      id,
      title: id,
      description: (pkg.description as string) || `The ${id} Kuralle template.`,
    });
  }

  writeFileSync(join(templatesOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Bundled ${manifest.length} template(s): ${manifest.map((m) => m.id).join(', ')}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} (not standalone-installable):`);
    for (const s of skipped) console.log(`  - ${s.id}: ${s.reason}`);
  }
  console.log(`@kuralle-agents/* deps rewritten to ${ariaRange}`);
}

main();
