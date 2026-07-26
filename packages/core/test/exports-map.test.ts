import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(here, '..');
const pkg = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8'));
const exports = pkg.exports as Record<string, { default: string }>;

function distTarget(sub: string): string {
  return pathToFileURL(resolve(coreRoot, exports[sub].default)).href;
}

describe('exports map', () => {
  test('every declared subpath resolves from built dist', async () => {
    const subpaths = Object.keys(exports);
    expect(subpaths.length).toBeGreaterThan(0);
    const results: string[] = [];
    for (const sub of subpaths) {
      try {
        await import(distTarget(sub));
      } catch (err) {
        results.push(`${sub} -> ${exports[sub].default}: ${(err as Error).message}`);
      }
    }
    expect(results).toEqual([]);
  });

  test('the misnamed ./hooks subpath is not present', () => {
    expect(exports).not.toHaveProperty('./hooks');
  });
});
