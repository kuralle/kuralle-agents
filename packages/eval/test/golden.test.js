import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { loadGoldenManifest, runGoldenSuite } from '../dist/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(packageRoot, 'fixtures/golden.manifest.json');

test('golden manifest is valid and non-empty', async () => {
  const manifest = await loadGoldenManifest(manifestPath);
  assert.ok(manifest.length > 0);
  assert.ok(manifest.every(entry => typeof entry.name === 'string' && entry.name.length > 0));
  assert.ok(manifest.every(entry => typeof entry.file === 'string' && entry.file.length > 0));
});

test('golden suite passes', async () => {
  const result = await runGoldenSuite(manifestPath);
  assert.equal(result.failed, 0);
  assert.equal(result.passed, result.total);
});
