import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * `DATABASE_URL` must never reach a client bundle. This app's actual defence is architectural
 * (see the comment on `server/index.ts`): the Next app under `web/` never imports `server/`,
 * `db/`, or `agent/` at all — every `/api/*` call is proxied to a separately-run Hono process
 * (`web/next.config.ts`'s `rewrites()`), so there is nothing for a bundler to pull in even by
 * accident.
 *
 * This test checks that architecture holds by deriving the actual client-side import graph —
 * not by asserting a hand-written list of "files that are fine". Starting from every file under
 * `web/` whose first statement is `'use client'` (a real Next.js client-boundary directive —
 * everything such a file imports, transitively, ships to the browser), it walks local imports
 * (relative or a `web/tsconfig.json` path alias) and fails if that reachable set touches
 * anything outside `web/`, or any file whose source contains the literal string `DATABASE_URL`.
 * `web/tsconfig.json`'s `paths` are read from the file itself, not duplicated here, so a new
 * alias is covered automatically instead of silently falling outside the walk.
 */

const APP_ROOT = resolve(import.meta.dir, '../..');
const WEB_ROOT = join(APP_ROOT, 'web');
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function readTsconfigPaths(tsconfigPath: string): Record<string, string[]> {
  const raw = readFileSync(tsconfigPath, 'utf8');
  // tsconfig.json is JSONC-ish in practice; this repo's files are plain JSON, so a plain parse
  // is enough — no comments to strip.
  const parsed = JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } };
  return parsed.compilerOptions?.paths ?? {};
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
      } else if (EXTENSIONS.includes(entry.slice(entry.lastIndexOf('.')))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function isClientEntry(filePath: string): boolean {
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    return trimmed === "'use client';" || trimmed === '"use client";' || trimmed === "'use client'" || trimmed === '"use client"';
  }
  return false;
}

// Matches `import ... from '<spec>'`, `import '<spec>'`, and `export ... from '<spec>'` — not
// `import(...)` dynamic calls, since this app has none and a false negative there would be a
// deliberate escape hatch worth its own review, not a silent miss.
const IMPORT_RE = /^\s*(import|export)\s+([^;]*?\bfrom\s+)?['"]([^'"]+)['"]/gm;

function localImportsOf(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf8');
  const specs: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const [full, , clause, spec] = match;
    const isTypeOnly = /^\s*(import|export)\s+type\b/.test(full);
    if (isTypeOnly) continue;
    if (clause === undefined && !full.trimStart().startsWith('import "') && !full.trimStart().startsWith("import '")) {
      continue; // a bare `export { x }` with no `from` clause — nothing to resolve
    }
    if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('@app/')) {
      specs.push(spec);
    }
  }
  return specs;
}

function resolveModule(fromFile: string, spec: string, aliases: Record<string, string[]>): string | undefined {
  let base: string;
  if (spec.startsWith('.')) {
    base = resolve(dirname(fromFile), spec);
  } else {
    const aliasKey = Object.keys(aliases).find((key) => spec === key.replace(/\*$/, '') || spec.startsWith(key.replace(/\*$/, '')));
    if (!aliasKey) return undefined;
    const target = aliases[aliasKey]![0]!.replace(/\*$/, '');
    const rest = spec.slice(aliasKey.replace(/\*$/, '').length);
    base = resolve(WEB_ROOT, target + rest);
  }
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of EXTENSIONS) {
    const indexed = join(base, `index${ext}`);
    if (existsSync(indexed)) return indexed;
  }
  return undefined; // a CSS import, an npm package that happens to start with '.', etc.
}

function clientReachableFiles(): Set<string> {
  const aliases = readTsconfigPaths(join(WEB_ROOT, 'tsconfig.json'));
  const entries = listSourceFiles(WEB_ROOT).filter(isClientEntry);
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!EXTENSIONS.includes(file.slice(file.lastIndexOf('.')))) continue;
    for (const spec of localImportsOf(file)) {
      const resolved = resolveModule(file, spec, aliases);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe('client bundle boundary', () => {
  it('finds at least one client entry, so the walk below is not vacuously true', () => {
    const entries = listSourceFiles(WEB_ROOT).filter(isClientEntry);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('never reaches a file outside web/, or one that references DATABASE_URL', () => {
    const reachable = clientReachableFiles();
    const offenders: string[] = [];
    for (const file of reachable) {
      const outsideWeb = !file.startsWith(WEB_ROOT + '/');
      const mentionsDbUrl = readFileSync(file, 'utf8').includes('DATABASE_URL');
      if (outsideWeb || mentionsDbUrl) offenders.push(relative(APP_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * SABOTAGE (workmanship rule 6), performed and observed, not asserted:
 *
 *   Added `import { resolveDefaultWorkspaceId } from '@app/server/runtime';` to the top of
 *   `web/components/Nav.tsx` (a real `'use client'` component mounted in every page's layout —
 *   not a scratch file, so the walk had no special-casing to dodge it). Confirmed with
 *   `grep -n resolveDefaultWorkspaceId web/components/Nav.tsx` that the import landed.
 *
 *   Result: `bun test test/web/no-server-secrets-in-client.test.ts` went from 2 pass to 1 pass /
 *   1 fail. "never reaches a file outside web/…" failed at `expect(offenders).toEqual([])` in
 *   this file, with `offenders` containing `server/runtime.ts` — the walk followed the `@app/*`
 *   alias exactly the way Next's own bundler would, and named the offending file precisely
 *   (not e.g. `db/client.ts`, which `server/runtime.ts` in turn imports, showing the walk
 *   stops at the first reachable offender rather than needing the deepest one).
 *
 *   Removed the import, re-ran the suite: 2 pass / 0 fail again.
 */
