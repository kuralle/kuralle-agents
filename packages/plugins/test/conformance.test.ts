import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin, type Diagnostic } from '../src/index.js';

interface ExpectedCase {
  ok: boolean;
  rejection?: { section: string; rule: string };
  skills?: string[];
  mcpServers?: string[];
  diagnostics: Diagnostic[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusRoot = join(__dirname, 'corpus');

function diagnosticKey(d: Diagnostic): string {
  return `${d.section}\0${d.rule}\0${d.origin}`;
}

function compareDiagnostics(actual: Diagnostic[], expected: Diagnostic[]): void {
  expect(actual).toHaveLength(expected.length);
  const actualKeys = actual.map(diagnosticKey).sort();
  const expectedKeys = expected.map(diagnosticKey).sort();
  expect(actualKeys).toEqual(expectedKeys);
}

function compareExactSet(actual: string[], expected: string[]): void {
  expect(actual).toHaveLength(expected.length);
  expect([...actual].sort()).toEqual([...expected].sort());
}

const caseDirs = readdirSync(corpusRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('Agent Plugins conformance corpus', () => {
  it('enumerates a non-zero case count', () => {
    expect(caseDirs.length).toBeGreaterThanOrEqual(24);
  });

  for (const caseName of caseDirs) {
    it(caseName, async () => {
      const caseDir = join(corpusRoot, caseName);
      const expected = JSON.parse(
        readFileSync(join(caseDir, 'expected.json'), 'utf8'),
      ) as ExpectedCase;
      const pluginRoot = join(caseDir, 'plugin');

      const result = await loadPlugin(pluginRoot);

      expect(result.ok).toBe(expected.ok);

      if (expected.rejection !== undefined) {
        expect(result.rejection).toEqual(expected.rejection);
      }

      if (expected.skills !== undefined) {
        compareExactSet(result.skills, expected.skills);
      }

      if (expected.mcpServers !== undefined) {
        compareExactSet(result.mcpServers, expected.mcpServers);
      }

      compareDiagnostics(result.diagnostics, expected.diagnostics);
    });
  }
});
