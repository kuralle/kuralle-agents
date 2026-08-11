import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentPlugin } from '../src/index.js';
import { loadFixtureIntoMemoryFs } from './fixture-fs.js';

/**
 * §7.1: the client SHOULD report an invalid skill.
 *
 * The `one-valid-one-malformed-skill` corpus case covers the outcome, and it does catch
 * lazy discovery today — but only incidentally. The harness calls `skills.list()` before
 * it compares diagnostics, so discovery does happen; it fails only because
 * `plugin.diagnostics` is a snapshot copied at return time, which a late `onDiagnostic`
 * push cannot reach. Make that array an alias of the live one and the corpus goes quiet
 * while the reporting is just as broken.
 *
 * This pins the timing directly: diagnostics are complete before anything touches
 * `skills`, which is what a caller that only wants to log the load actually observes.
 */

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  'corpus',
  'one-valid-one-malformed-skill',
  'plugin',
);

describe('skill discovery inside loadAgentPlugin', () => {
  it('reports an invalid skill before anyone asks for the skill list', async () => {
    const { fs, root } = await loadFixtureIntoMemoryFs(CORPUS);

    const result = await loadAgentPlugin(fs, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Read diagnostics with `skills` still untouched. Listing first would make discovery
    // happen here rather than in the loader, which is the failure this test exists for.
    expect(
      result.plugin.diagnostics.map((d) => [d.section, d.rule, d.origin]),
    ).toEqual([['7.1', 'skill-invalid', 'skills/bad-skill/SKILL.md']]);

    // The valid skill still loads: one bad SKILL.md must not take the good one with it.
    const skills = await result.plugin.skills.list();
    expect(skills.map((skill) => skill.name)).toEqual(['good-skill']);
  });
});
