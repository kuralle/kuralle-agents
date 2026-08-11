import { describe, expect, it } from 'bun:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { loadAgentPlugin, type Diagnostic } from '@kuralle-agents/plugins';
import { mcpTools } from '../src/node/index.js';

/**
 * §4.1(4): a `command` or `cwd` that fails containment makes the server entry invalid.
 * §4.1(3) makes containment a property of the **filesystem-resolved** path.
 *
 * Both cannot hold at parse time. §7.2.1 permits `cwd: "${PLUGIN_DATA}"` — the
 * specification's own example — and PLUGIN_DATA is a directory the client must create
 * *before launching*, so at parse time `realpath` would reject it. The parse-time check
 * therefore stays lexical, catching `../`, and this one runs at launch, catching symlinks.
 *
 * A lexical check sees `./bin/server` and says "inside the plugin". It cannot see that the
 * file is a symlink to something else entirely.
 */

const FIXTURES = dirname(fileURLToPath(new URL('./fixtures/x', import.meta.url)));

async function launch(pluginDir: string): Promise<{
  tools: string[];
  diagnostics: Diagnostic[];
  skills: string[];
  close: () => Promise<void>;
}> {
  const fs = new NodeFileSystem(FIXTURES);
  const loaded = await loadAgentPlugin(fs, `/${pluginDir}`);
  if (!loaded.ok) {
    throw new Error(`loadAgentPlugin rejected: ${loaded.rejection.rule}`);
  }

  const diagnostics: Diagnostic[] = [...loaded.plugin.diagnostics];
  const toolset = await mcpTools(loaded.plugin.mcpServers, {
    fs,
    onDiagnostic: (d) => diagnostics.push(d),
  });

  return {
    tools: Object.keys(toolset.tools),
    diagnostics,
    skills: (await loaded.plugin.skills.list()).map((skill) => skill.name),
    close: toolset.close,
  };
}

describe('launch-time containment for declared paths', () => {
  it('skips a server whose command symlinks outside the plugin root', async () => {
    const { tools, diagnostics, skills, close } = await launch(
      'symlink-escape-plugin',
    );

    try {
      expect(tools).toEqual([]);
      expect(
        diagnostics.map((d) => [d.section, d.rule]),
      ).toContainEqual(['4.1', 'path-escapes-plugin-root']);

      // §11.3: one invalid component must not remove an independently valid one.
      expect(skills).toEqual(['greet']);
    } finally {
      await close();
    }
  }, 30_000);

  it('launches a server whose command symlinks to a target inside the plugin root', async () => {
    // The discriminator against "reject every symlink", which would pass the test above
    // and break a perfectly conformant plugin. §4.1(3) permits a link that stays inside.
    const { tools, diagnostics, close } = await launch('symlink-inside-plugin');

    try {
      expect(tools).toContain('local__report_env');
      expect(diagnostics.map((d) => d.rule)).not.toContain(
        'path-escapes-plugin-root',
      );
    } finally {
      await close();
    }
  }, 30_000);

  it("still launches the specification's own cwd example", async () => {
    // `cwd: "${PLUGIN_DATA}"` is the shape a resolved parse-time check would have made
    // impossible. It has to survive the launch-time check that replaced it.
    const { tools, diagnostics, close } = await launch('cwd-data-plugin');

    try {
      expect(tools).toContain('local__report_env');
      expect(diagnostics.map((d) => d.rule)).not.toContain(
        'path-escapes-plugin-root',
      );
    } finally {
      await close();
    }
  }, 30_000);
});
