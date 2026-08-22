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

const REPO = resolve(import.meta.dir, '..');
const SRC = join(REPO, 'apps/docs/src/content/docs/guides');
const OUT = join(REPO, 'packages/core/guides');
const SITE = 'https://agents.kuralle.com';

const ASIDE_LABEL: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  caution: 'Caution',
  danger: 'Danger',
};

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

/** Marks every line that sits inside a fenced code block, so no rewrite touches code. */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null && open) {
      fence = open[1][0];
      mask.push(true);
      continue;
    }
    if (fence !== null && open && open[1][0] === fence) {
      fence = null;
      mask.push(true);
      continue;
    }
    mask.push(fence !== null);
  }
  return mask;
}

/** `import x from '../../../examples/a/b.ts?raw'` → { x: absolute path } */
function collectRawImports(lines: string[], mask: boolean[]): Map<string, string> {
  const raws = new Map<string, string>();
  lines.forEach((line, i) => {
    if (mask[i]) return;
    const m = /^import\s+(\w+)\s+from\s+'([^']+)\?raw';?\s*$/.exec(line);
    if (m) raws.set(m[1], resolve(SRC, m[2]));
  });
  return raws;
}

function isStrippableImport(line: string): boolean {
  return (
    /^import\s+\{[^}]*\}\s+from\s+'@astrojs\/starlight\/components';?\s*$/.test(line) ||
    /^import\s+\w+\s+from\s+'[^']+\?raw';?\s*$/.test(line)
  );
}

function rewriteLinks(line: string): string {
  return line
    .replace(
      /\]\(\/guides\/([a-z0-9-]+)\/?(#[^)]*)?\)/g,
      (_m, page, anchor) => `](./${page}.md${anchor ?? ''})`,
    )
    .replace(/\]\((\/[^)]*)\)/g, (_m, path) => `](${SITE}${path})`);
}

function blockquote(text: string): string[] {
  return text.split('\n').map((l) => (l.trim() === '' ? '>' : `> ${l}`));
}

async function transform(file: string): Promise<string> {
  const raw = await readFile(join(SRC, file), 'utf8');
  const { fm, body } = parseFrontmatter(raw);
  const lines = body.split('\n');
  const mask = fenceMask(lines);
  const rawImports = collectRawImports(lines, mask);

  const out: string[] = [`# ${fm.title}`, ''];
  if (fm.description) out.push(fm.description, '');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (mask[i]) {
      out.push(line);
      i += 1;
      continue;
    }

    if (isStrippableImport(line)) {
      i += 1;
      continue;
    }

    // <Code code={x} lang="ts" title="a.ts" /> → the file's contents, inlined.
    const code = /^<Code\s+code=\{(\w+)\}\s+lang="([^"]+)"(?:\s+title="([^"]+)")?\s*\/>\s*$/.exec(
      line,
    );
    if (code) {
      const path = rawImports.get(code[1]);
      if (!path) throw new Error(`${file}: <Code> references unknown import ${code[1]}`);
      const source = (await readFile(path, 'utf8')).trimEnd();
      if (code[3]) out.push(`\`${code[3]}\`:`, '');
      out.push('```' + code[2], source, '```');
      i += 1;
      continue;
    }

    // <Aside …>…</Aside> → a blockquote, so the callout survives as plain Markdown.
    const aside = /^<Aside(?:\s+type="(\w+)")?(?:\s+title="((?:[^"\\]|\\.)*)")?\s*>\s*(.*)$/.exec(
      line,
    );
    if (aside) {
      const label = aside[2] ?? ASIDE_LABEL[aside[1] ?? 'note'] ?? 'Note';
      const inner: string[] = [];
      const rest = aside[3];
      const closeOnSame = rest.indexOf('</Aside>');
      if (closeOnSame >= 0) {
        inner.push(rest.slice(0, closeOnSame));
        i += 1;
      } else {
        if (rest.trim()) inner.push(rest);
        i += 1;
        while (i < lines.length && !lines[i].includes('</Aside>')) {
          inner.push(lines[i]);
          i += 1;
        }
        if (i >= lines.length) throw new Error(`${file}: unclosed <Aside>`);
        const tail = lines[i].slice(0, lines[i].indexOf('</Aside>'));
        if (tail.trim()) inner.push(tail);
        i += 1;
      }
      const text = inner.map(rewriteLinks).join('\n').trim();
      out.push(...blockquote(`**${label}**${text ? `\n\n${text}` : ''}`), '');
      continue;
    }

    // <Steps>/<Tabs> are layout only; <TabItem label="X"> becomes a heading.
    if (/^<\/?(Steps|Tabs)>\s*$/.test(line) || /^<\/TabItem>\s*$/.test(line)) {
      i += 1;
      continue;
    }
    const tab = /^<TabItem\s+label="([^"]+)"\s*>\s*$/.exec(line);
    if (tab) {
      out.push(`#### ${tab[1]}`, '');
      i += 1;
      continue;
    }

    out.push(rewriteLinks(line));
    i += 1;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
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
