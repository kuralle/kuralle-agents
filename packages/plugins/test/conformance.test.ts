import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentPlugin, type Diagnostic } from '../src/index.js';
import { loadFixtureIntoMemoryFs } from './fixture-fs.js';

interface ExpectedCase {
  ok: boolean;
  rejection?: { section: string; rule: string };
  skills?: string[];
  mcpServers?: string[];
  flows?: string[];
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
      const { fs, root } = await loadFixtureIntoMemoryFs(pluginRoot);

      const result = await loadAgentPlugin(fs, root);

      expect(result.ok).toBe(expected.ok);

      if (!result.ok) {
        expect(expected.rejection).toBeDefined();
        expect(result.rejection.section).toBe(expected.rejection!.section);
        expect(result.rejection.rule).toBe(expected.rejection!.rule);
        compareDiagnostics([...result.diagnostics], expected.diagnostics);
        return;
      }

      if (expected.skills !== undefined) {
        const skillNames = (await result.plugin.skills.list()).map(
          (skill) => skill.name,
        );
        compareExactSet(skillNames, expected.skills);
      }

      if (expected.mcpServers !== undefined) {
        const serverNames = result.plugin.mcpServers.map(
          (server) => server.name,
        );
        compareExactSet(serverNames, expected.mcpServers);
      }

      if (expected.flows !== undefined) {
        const flowNames = result.plugin.flows.map((flow) => flow.name);
        compareExactSet(flowNames, expected.flows);
      }

      compareDiagnostics([...result.plugin.diagnostics], expected.diagnostics);
    });
  }
});
