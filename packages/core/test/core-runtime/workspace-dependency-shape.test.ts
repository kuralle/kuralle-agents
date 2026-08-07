import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A workspace package must not list an internal package in BOTH `dependencies`
 * and `peerDependencies`.
 *
 * The two declarations say opposite things. A dependency means "I install my
 * own copy." A peer dependency means "the host supplies it so we share one."
 * Declaring both asks the package manager for a private copy *and* demands the
 * consumer provide one, and which wins is a function of the installer and the
 * hoisting layout rather than anything this repo decides.
 *
 * `CLAUDE.md` already records what that costs: two copies of `core` in a
 * consumer's tree produce `tsc` errors about "separate declarations of a
 * private property", because core's classes carry private fields and two
 * copies are two nominally distinct types. The published metadata was inviting
 * the duplicate rather than preventing it.
 *
 * This guard is deliberately narrow. It does NOT assert which shape a package
 * should use — that is a per-package judgement (an executable wants a plain
 * dependency; a library the consumer imports alongside core wants a peer). It
 * asserts only that a package does not claim both at once, which is
 * unambiguous regardless of which convention you pick.
 */
const repositoryRoot = resolve(import.meta.dir, '../../../..');
const packagesRoot = resolve(repositoryRoot, 'packages');
const INTERNAL_SCOPE = '@kuralle-agents/';

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function manifests(): Array<{ dir: string; manifest: Manifest }> {
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = resolve(packagesRoot, entry.name, 'package.json');
      if (!existsSync(file)) return [];
      return [{ dir: entry.name, manifest: JSON.parse(readFileSync(file, 'utf8')) as Manifest }];
    });
}

test('no workspace package declares an internal package as both dependency and peer', () => {
  const offenders = manifests().flatMap(({ dir, manifest }) => {
    const deps = Object.keys(manifest.dependencies ?? {});
    const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
    const both = deps.filter((name) => name.startsWith(INTERNAL_SCOPE) && peers.has(name));
    return both.length > 0 ? [{ package: manifest.name ?? dir, both: both.sort() }] : [];
  });

  expect(offenders).toEqual([]);
});
