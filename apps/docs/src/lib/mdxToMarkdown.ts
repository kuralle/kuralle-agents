/**
 * Turns a Starlight MDX page into plain Markdown.
 *
 * Two consumers share this so they cannot drift: the `/<slug>.md` endpoint in
 * `src/pages/[...slug].md.ts`, and `scripts/sync-package-guides.ts`, which
 * generates the copy shipped inside `@kuralle-agents/core`. A reader fetching
 * a page over HTTP and a reader opening it in `node_modules` get the same text.
 *
 * Serving `entry.body` raw is not enough here. Twelve guides pull their example
 * through `import x from '…/foo.ts?raw'` and render it with `<Code code={x} />`,
 * so the raw body carries an import statement and a component tag with no code
 * in between. Every rewrite below is code-fence aware, because TypeScript
 * generics (`<Record`, `<KuralleUIMessage`) look exactly like MDX components.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ASIDE_LABEL: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  caution: 'Caution',
  danger: 'Danger',
};

export interface TransformInput {
  /** Frontmatter title, rendered as the H1. */
  title: string;
  /** Frontmatter description, rendered as the lead paragraph. */
  description?: string;
  /** MDX body with frontmatter already stripped. */
  body: string;
  /** Directory the page's relative `?raw` imports resolve against. */
  baseDir: string;
  /** Absolute base for site-root links such as `/guides/flows`. */
  site: string;
  /** Rewrites `/guides/<page>` to a sibling. Omit to leave those absolute. */
  relativeGuideLinks?: boolean;
}

/** Marks every line inside a fenced code block, so no rewrite touches code. */
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

function collectRawImports(lines: string[], mask: boolean[], baseDir: string): Map<string, string> {
  const raws = new Map<string, string>();
  lines.forEach((line, i) => {
    if (mask[i]) return;
    const m = /^import\s+(\w+)\s+from\s+'([^']+)\?raw';?\s*$/.exec(line);
    if (m) raws.set(m[1], resolve(baseDir, m[2]));
  });
  return raws;
}

function isStrippableImport(line: string): boolean {
  return (
    /^import\s+\{[^}]*\}\s+from\s+'@astrojs\/starlight\/components';?\s*$/.test(line) ||
    /^import\s+\w+\s+from\s+'[^']+\?raw';?\s*$/.test(line)
  );
}

function blockquote(text: string): string[] {
  return text.split('\n').map((l) => (l.trim() === '' ? '>' : `> ${l}`));
}

export function mdxToMarkdown(input: TransformInput): string {
  const { title, description, body, baseDir, site, relativeGuideLinks = false } = input;

  const rewriteLinks = (line: string): string => {
    const withGuides = relativeGuideLinks
      ? line.replace(
          /\]\(\/guides\/([a-z0-9-]+)\/?(#[^)]*)?\)/g,
          (_m, page, anchor) => `](./${page}.md${anchor ?? ''})`,
        )
      : line;
    return withGuides.replace(/\]\((\/[^)]*)\)/g, (_m, path) => `](${site}${path})`);
  };

  const lines = body.split('\n');
  const mask = fenceMask(lines);
  const rawImports = collectRawImports(lines, mask, baseDir);

  const out: string[] = [`# ${title}`, ''];
  if (description) out.push(description, '');

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

    const code = /^<Code\s+code=\{(\w+)\}\s+lang="([^"]+)"(?:\s+title="([^"]+)")?\s*\/>\s*$/.exec(
      line,
    );
    if (code) {
      const path = rawImports.get(code[1]);
      if (!path) throw new Error(`<Code> references unknown import ${code[1]}`);
      const source = readFileSync(path, 'utf8').trimEnd();
      if (code[3]) out.push(`\`${code[3]}\`:`, '');
      out.push('```' + code[2], source, '```');
      i += 1;
      continue;
    }

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
        if (i >= lines.length) throw new Error('unclosed <Aside>');
        const tail = lines[i].slice(0, lines[i].indexOf('</Aside>'));
        if (tail.trim()) inner.push(tail);
        i += 1;
      }
      const text = inner.map(rewriteLinks).join('\n').trim();
      out.push(...blockquote(`**${label}**${text ? `\n\n${text}` : ''}`), '');
      continue;
    }

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
