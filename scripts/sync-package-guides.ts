#!/usr/bin/env bun
/**
 * Generates `packages/core/guides/` from the published docs site.
 *
 * The guides shipped inside the npm tarball must match the installed version, so
 * they are generated from `apps/docs` rather than hand-maintained. A second
 * hand-written copy drifted six weeks behind the site before this existed.
 *
 * Run `bun scripts/sync-package-guides.ts` and commit the result.
 *
 * `--check` compares instead of writing, and exits non-zero when the committed
 * copy is stale. The type gate and publish both run it that way. Regenerating
 * during publish would dirty the tree and `pnpm publish` refuses that, so the
 * generated files are committed and verified rather than built on the fly.
 */
import { readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mdxToMarkdown } from '../apps/docs/src/lib/mdxToMarkdown.ts';

const REPO = resolve(import.meta.dir, '..');
const SRC = join(REPO, 'apps/docs/src/content/docs/guides');
const OUT = join(REPO, 'packages/core/guides');
const SITE = 'https://agents.kuralle.com';

interface Frontmatter {
  title: string;
  description: string;
}

function parseFrontmatter(src: string): { fm: Frontmatter; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!match) throw new Error('missing frontmatter');
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  if (!fields.title) throw new Error('frontmatter has no title');
  return {
    fm: { title: fields.title, description: fields.description ?? '' },
    body: src.slice(match[0].length),
  };
}

async function transform(file: string): Promise<string> {
  const { fm, body } = parseFrontmatter(await readFile(join(SRC, file), 'utf8'));
  return mdxToMarkdown({
    title: fm.title,
    description: fm.description,
    body,
    baseDir: SRC,
    site: SITE,
    // The packaged copy sits in one flat directory, so a link to another guide
    // is a sibling file rather than a URL.
    relativeGuideLinks: true,
  });
}

const READING_ORDER = [
  'quickstart',
  'build-an-agent',
  'agents',
  'tools',
  'flows',
  'flow-execution',
  'routing',
  'policy',
  'durable-execution',
  'sessions',
  'memory',
  'knowledge',
  'skills',
  'workspace',
  'dynamic-flows',
  'plugins',
  'mcp',
  'multimodal',
  'templates',
  'file-authored-agents',
  'agent-definitions-database',
  'agent-builder-react',
  'engagement',
  'clients',
  'observability',
  'deployment',
  'cli',
  'pi-driver',
];

const files = (await readdir(SRC)).filter((f) => f.endsWith('.mdx')).sort();
const names = files.map((f) => f.replace(/\.mdx$/, ''));

const unordered = names.filter((n) => !READING_ORDER.includes(n));
if (unordered.length) {
  throw new Error(
    `New guide(s) not in READING_ORDER: ${unordered.join(', ')}. ` +
      `Add them to scripts/sync-package-guides.ts so the index stays complete.`,
  );
}

const check = process.argv.includes('--check');

const titles = new Map<string, Frontmatter>();
const generated = new Map<string, string>();
for (const file of files) {
  const name = file.replace(/\.mdx$/, '');
  generated.set(`${name}.md`, await transform(file));
  titles.set(name, parseFrontmatter(await readFile(join(SRC, file), 'utf8')).fm);
}

const index = [
  '# Kuralle guides',
  '',
  'These guides are generated from the documentation site and match the version of',
  '`@kuralle-agents/core` you installed. The same pages are published at',
  `<${SITE}>, where they always describe the latest release.`,
  '',
  'Read in this order for a full picture; jump straight to a page to solve one task.',
  '',
  ...READING_ORDER.filter((n) => titles.has(n)).map(
    (n, idx) => `${idx + 1}. [${titles.get(n)!.title}](./${n}.md) — ${titles.get(n)!.description}`,
  ),
  '',
].join('\n');
generated.set('README.md', index);

if (check) {
  const existing = new Set(
    (await readdir(OUT).catch(() => [] as string[])).filter((f) => f.endsWith('.md')),
  );
  const stale: string[] = [];
  for (const [name, content] of generated) {
    const current = await readFile(join(OUT, name), 'utf8').catch(() => null);
    if (current !== content) stale.push(name);
    existing.delete(name);
  }
  for (const orphan of existing) stale.push(`${orphan} (no longer in apps/docs)`);
  if (stale.length) {
    console.error(
      `packages/core/guides/ is stale:\n  ${stale.join('\n  ')}\n\n` +
        `Run: bun scripts/sync-package-guides.ts`,
    );
    process.exit(1);
  }
  console.log(`packages/core/guides/ is in sync (${generated.size} files)`);
} else {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  for (const [name, content] of generated) await writeFile(join(OUT, name), content);
  console.log(`synced ${files.length} guides → packages/core/guides/`);
}
