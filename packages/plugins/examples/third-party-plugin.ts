/**
 * Agent Plugins, live — load the vendored remotion-dev/codex-plugin fixture offline.
 *
 * Mirrors the real published `remotion-dev/codex-plugin` (remotion@4.0.507, MIT) from
 * `packages/plugins/test/fixtures/remotion-codex-plugin/` onto an InMemoryFs and loads it
 * with `loadAgentPlugin`. No network — CI-safe.
 *
 * Run:
 *   bun packages/plugins/examples/third-party-plugin.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentPlugin } from '@kuralle-agents/plugins';
import { loadFixtureIntoMemoryFs } from '../test/fixture-fs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const remotionFixture = join(__dirname, '../test/fixtures/remotion-codex-plugin');

const EXPECTED_SKILL_NAMES = [
  'remotion-best-practices',
  'remotion-captions',
  'remotion-create',
  'remotion-docs',
  'remotion-interactivity',
  'remotion-maps',
  'remotion-markup',
  'remotion-multimedia',
  'remotion-render',
  'remotion-saas',
  'remotion-studio',
  'remotion-upgrade',
];

async function main(): Promise<void> {
  const failures: string[] = [];

  const { fs, root } = await loadFixtureIntoMemoryFs(remotionFixture);
  const result = await loadAgentPlugin(fs, root);

  if (!result.ok) {
    failures.push(
      `load succeeded: result.ok === true (rejected: ${result.rejection.message})`,
    );
  } else {
    const { plugin } = result;
    const { manifest } = plugin;

    if (manifest.name !== 'remotion') {
      failures.push(`manifest name: expected "remotion", got "${manifest.name}"`);
    }
    if (manifest.version !== '4.0.507') {
      failures.push(`manifest version: expected "4.0.507", got "${manifest.version ?? '(missing)'}"`);
    }
    if (manifest.license !== 'MIT') {
      failures.push(`manifest license: expected "MIT", got "${manifest.license ?? '(missing)'}"`);
    }

    const skills = await plugin.skills.list();
    if (skills.length !== 12) {
      failures.push(`skill count: expected exactly 12, got ${skills.length}`);
    }

    const skillNames = skills.map((skill) => skill.name).sort();
    const expectedSorted = [...EXPECTED_SKILL_NAMES].sort();
    if (JSON.stringify(skillNames) !== JSON.stringify(expectedSorted)) {
      failures.push(
        `skill names: expected [${expectedSorted.join(', ')}], got [${skillNames.join(', ')}]`,
      );
    }

    for (const skill of skills) {
      if (!skill.description || skill.description.length === 0) {
        failures.push(`every skill description: "${skill.name}" has empty description`);
      }
    }

    const body = await plugin.skills.loadBody('remotion-best-practices');
    if (!body || body.length <= 500) {
      failures.push(
        `loadBody('remotion-best-practices'): expected non-empty body with length > 500, got length ${body?.length ?? 0}`,
      );
    }

    if (plugin.mcpServers.length !== 0) {
      failures.push(
        `mcpServers: expected empty array, got ${plugin.mcpServers.length} server(s)`,
      );
    }

    if (plugin.diagnostics.length !== 0) {
      failures.push(
        `diagnostics: expected empty array, got ${plugin.diagnostics.length} diagnostic(s): ${plugin.diagnostics.map((d) => d.rule).join(', ')}`,
      );
    }

    if (failures.length === 0) {
      console.log(
        `PASS — loaded plugin "${manifest.name}" v${manifest.version} (${manifest.license}), ${skills.length} skills, 0 MCP servers, 0 diagnostics.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
}

await main();
