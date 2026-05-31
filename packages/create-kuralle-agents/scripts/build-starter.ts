/**
 * Regenerate the content of the public `kuralle/starter` repo from the monorepo's
 * `apps/templates/*`. For each standalone-installable template it:
 *   - skips cruft (node_modules, .next, dist, lockfiles, .git, .turbo) and every
 *     real env file (only `.env.example` is kept — never bundle secrets)
 *   - rewrites `workspace:*` deps on published `@kuralle-agents/*` packages to a real range
 *   - stores `.gitignore` as `_gitignore` (npm/git tooling strips a real one; the CLI
 *     restores it on scaffold)
 *   - SKIPS templates that depend on a private/internal workspace package
 *     (e.g. `@kuralle-templates/_shared-*`), which can't be installed standalone
 *
 * Output goes to `<repoRoot>/.starter-build/`. Publish it with:
 *   cd .starter-build && git init -b main && git add -A && git commit -m "..." \
 *     && git push --force git@github.com:kuralle/starter.git main && git tag vMAJOR.MINOR && git push --tags
 *
 * Run via `npm run build-starter`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const templatesSrc = join(repoRoot, 'apps', 'templates');
const stagingOut = join(repoRoot, '.starter-build');

// The version published @kuralle-agents/* deps should resolve to (the fixed monorepo version).
const coreVersion = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'kuralle-core', 'package.json'), 'utf8'),
).version as string;
const publishedRange = `^${coreVersion}`;

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', '.git', 'out']);
const SKIP_FILES = new Set(['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'tsconfig.tsbuildinfo']);

type ManifestEntry = { id: string; title: string; description: string };

function isWorkspaceDep(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('workspace:');
}

/** A template is publishable only if every workspace dep is a published @kuralle-agents/* package. */
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

/** Rewrite workspace:* @kuralle-agents/* deps to the published range. */
function sanitizePkgJson(raw: string): string {
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (isWorkspaceDep(version) && name.startsWith('@kuralle-agents/')) {
        deps[name] = publishedRange;
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
      // Never publish real env files — only the .env.example template.
      if (name.startsWith('.env') && name !== '.env.example') return false;
      return true;
    },
  });
  const outPkgPath = join(outDir, 'package.json');
  if (existsSync(outPkgPath)) {
    writeFileSync(outPkgPath, sanitizePkgJson(readFileSync(outPkgPath, 'utf8')));
  }
  // Store .gitignore as _gitignore; the CLI renames it back on scaffold.
  const gi = join(outDir, '.gitignore');
  if (existsSync(gi)) {
    cpSync(gi, join(outDir, '_gitignore'));
    rmSync(gi);
  }
}

function renderReadme(manifest: ManifestEntry[]): string {
  const rows = manifest.map((m) => `| [\`${m.id}\`](./${m.id}) | ${m.description} |`).join('\n');
  return `# Kuralle Starter Templates

Official starter templates for [Kuralle](https://github.com/kuralle/kuralle-agents) — the TypeScript framework for conversational AI agents.

You don't clone this repo directly. Scaffold a project with the CLI:

\`\`\`bash
npm create kuralle-agents@latest my-app
\`\`\`

It fetches the template you pick from this repo (via [giget](https://github.com/unjs/giget)), sets your project name, and prints the next steps.

## Templates

| Template | What it is |
| --- | --- |
${rows}

## How this repo is maintained

This repo is **generated** — don't hand-edit templates here. They come from \`apps/templates/*\` in the framework monorepo: \`workspace:*\` deps are rewritten to the matching published \`@kuralle-agents/*\` version, and \`.gitignore\` is stored as \`_gitignore\` (the CLI restores it on scaffold). Run \`npm run build-starter\` in the framework repo, then publish here and tag the matching \`vMAJOR.MINOR\`.

## License

MIT
`;
}

function main(): void {
  rmSync(stagingOut, { recursive: true, force: true });
  mkdirSync(stagingOut, { recursive: true });

  const entries = readdirSync(templatesSrc).filter((d) => {
    if (d.startsWith('_')) return false; // _shared
    const dir = join(templatesSrc, d);
    return statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'));
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
    copyTemplate(srcDir, join(stagingOut, id));
    manifest.push({
      id,
      title: id,
      description: (pkg.description as string) || `The ${id} Kuralle template.`,
    });
  }

  writeFileSync(join(stagingOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(stagingOut, 'README.md'), renderReadme(manifest));

  console.log(`Built ${manifest.length} template(s) into ${stagingOut}: ${manifest.map((m) => m.id).join(', ')}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} (not standalone-installable):`);
    for (const s of skipped) console.log(`  - ${s.id}: ${s.reason}`);
  }
  console.log(`\nReview the manifest, then publish to kuralle/starter and tag the matching vMAJOR.MINOR.`);
}

main();
