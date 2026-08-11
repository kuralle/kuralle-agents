import { describe, expect, it } from 'bun:test';
import { validateManifestJson } from '../src/manifest.js';

/**
 * The conformance corpus asserts what a manifest is *rejected* for. Nothing asserted what
 * an accepted manifest actually carries, which is how a second pass could rebuild every
 * field by casting and silently disagree with the validator that had just proved it.
 *
 * These pin the values.
 */

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

function manifestOf(fields: Record<string, unknown>) {
  const result = validateManifestJson(
    JSON.stringify({ $schema: SCHEMA, name: 'values', ...fields }),
  );
  if (!result.ok) {
    throw new Error(`unexpectedly rejected: ${result.rejection.rule}`);
  }
  return result;
}

describe('an accepted manifest carries the validated values', () => {
  it('keeps every optional field it validated', () => {
    // The old `buildManifest` re-tested each field with `typeof` before copying it. A
    // field that failed that second test was dropped in silence rather than rejected, so
    // nothing here could tell a validated field from a lost one.
    const { manifest } = manifestOf({
      version: '2.1.0',
      description: 'Values, carried.',
      homepage: 'https://example.com',
      repository: 'https://github.com/example/values',
      license: 'MIT',
      keywords: ['alpha', 'beta'],
      author: { name: 'Ada', email: 'ada@example.com' },
      extensions: { 'com.example.client': { setting: true } },
    });

    expect(manifest).toEqual({
      $schema: SCHEMA,
      name: 'values',
      version: '2.1.0',
      description: 'Values, carried.',
      homepage: 'https://example.com',
      repository: 'https://github.com/example/values',
      license: 'MIT',
      keywords: ['alpha', 'beta'],
      author: { name: 'Ada', email: 'ada@example.com' },
      extensions: { 'com.example.client': { setting: true } },
    });
  });

  it('reports an empty author object as absent', () => {
    // §5.4 makes all three author fields optional, so `{}` is valid — the manifest is not
    // rejected. It names nobody, so it is reported as absent rather than as an empty
    // object: a consumer testing `manifest.author` never has to re-test for emptiness.
    const { manifest, diagnostics } = manifestOf({ author: {} });

    expect('author' in manifest).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it('drops an extension namespace that does not map to an object, and says so', () => {
    // §8.1 requires member values to be objects; §5.2 and §11.3 make the violation
    // non-fatal. The old cast asserted the shape instead of checking it, which would have
    // handed a consumer a number typed as a record.
    const { manifest, diagnostics } = manifestOf({
      extensions: { 'com.example.good': { on: true }, 'com.example.bad': 42 },
    });

    expect(manifest.extensions).toEqual({ 'com.example.good': { on: true } });
    expect(diagnostics.map((d) => [d.section, d.rule])).toEqual([
      ['8.1', 'extensions-not-an-object'],
    ]);
  });
});
