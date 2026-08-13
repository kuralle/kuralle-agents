import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryFs } from '@kuralle-agents/fs';
import { loadAgentPlugin } from '../src/index.js';
import { loadFixtureIntoMemoryFs } from './fixture-fs.js';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), 'corpus');

const MANIFEST = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'flow-host',
  version: '1.0.0',
});

const GREET_FLOW = JSON.stringify({
  name: 'greet',
  description: 'Say hello.',
  start: 'hello',
  nodes: [
    {
      kind: 'reply',
      id: 'hello',
      response: { template: 'Hello.' },
      next: { end: 'done' },
    },
  ],
});

const LOOKUP_FLOW = JSON.stringify({
  name: 'lookup-flow',
  description: 'Look something up.',
  start: 'go',
  nodes: [
    {
      kind: 'action',
      id: 'go',
      tool: 'lookup',
      next: { end: 'done' },
    },
  ],
});

const SKILL = `---
name: good-skill
description: A valid skill for isolation testing.
---

Valid skill body.
`;

const MCP = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    weather: {
      type: 'streamable-http',
      url: 'https://tools.example.com/mcp',
    },
  },
});

async function pluginWith(files: Record<string, string>): Promise<InMemoryFs> {
  const fs = new InMemoryFs();
  await fs.mkdir('/plugin', { recursive: true });
  await fs.writeFile('/plugin/plugin.json', MANIFEST);
  for (const [path, content] of Object.entries(files)) {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(path, content);
  }
  return fs;
}

describe('flow discovery inside loadAgentPlugin', () => {
  it('loads exactly one flow and one flows diagnostic when a sibling file is malformed', async () => {
    const { fs, root } = await loadFixtureIntoMemoryFs(
      join(CORPUS, 'one-valid-one-malformed-flow', 'plugin'),
    );

    const result = await loadAgentPlugin(fs, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plugin.flows.map((flow) => flow.name)).toEqual(['greet']);
    expect(
      result.plugin.diagnostics.map((d) => [d.section, d.rule, d.origin]),
    ).toEqual([['flows', 'flow-invalid-json', 'flows/broken.flow.json']]);
  });

  it('skips a flow whose action names a tool the host did not register', async () => {
    const fs = await pluginWith({
      '/plugin/flows/lookup.flow.json': LOOKUP_FLOW,
    });

    const result = await loadAgentPlugin(fs, '/plugin', { hostTools: ['other'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plugin.flows).toEqual([]);
    expect(result.plugin.diagnostics).toHaveLength(1);
    const diagnostic = result.plugin.diagnostics[0];
    expect(diagnostic?.section).toBe('flows');
    expect(diagnostic?.rule).toBe('missing-reference');
    expect(diagnostic?.origin).toBe('flows/lookup.flow.json');
    expect(diagnostic?.message).toContain('lookup');
  });

  it('loads the same unregistered-tool flow when hostTools is omitted (gated index)', async () => {
    const fs = await pluginWith({
      '/plugin/flows/lookup.flow.json': LOOKUP_FLOW,
    });

    const result = await loadAgentPlugin(fs, '/plugin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plugin.flows.map((flow) => flow.name)).toEqual(['lookup-flow']);
    expect(result.plugin.diagnostics).toEqual([]);
  });

  it('keeps skills and MCP byte-identical with and without a flows/ directory', async () => {
    const withoutFlows = await pluginWith({
      '/plugin/skills/good-skill/SKILL.md': SKILL,
      '/plugin/mcp.json': MCP,
    });

    const withFlows = await pluginWith({
      '/plugin/skills/good-skill/SKILL.md': SKILL,
      '/plugin/mcp.json': MCP,
      '/plugin/flows/greet.flow.json': GREET_FLOW,
    });

    const before = await loadAgentPlugin(withoutFlows, '/plugin');
    const after = await loadAgentPlugin(withFlows, '/plugin');
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    expect(JSON.stringify(before.plugin.mcpServers)).toBe(
      JSON.stringify(after.plugin.mcpServers),
    );
    expect(JSON.stringify(await before.plugin.skills.list())).toBe(
      JSON.stringify(await after.plugin.skills.list()),
    );
    expect(before.plugin.diagnostics.filter((d) => d.section !== 'flows')).toEqual(
      after.plugin.diagnostics.filter((d) => d.section !== 'flows'),
    );
    expect(after.plugin.flows.map((flow) => flow.name)).toEqual(['greet']);
  });

  it('rejects a flow path that escapes the plugin root the same way other reads do', async () => {
    const { fs, root } = await loadFixtureIntoMemoryFs(
      join(CORPUS, 'flow-symlink-escapes-root', 'plugin'),
    );

    const result = await loadAgentPlugin(fs, root);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plugin.flows.map((flow) => flow.name)).toEqual(['greet']);
    expect(
      result.plugin.diagnostics.map((d) => [d.section, d.rule, d.origin]),
    ).toEqual([['flows', 'path-escapes-plugin-root', 'flows/escaped.flow.json']]);
  });

  it('treats the plugin mcp.json server name as a prospective tool when hostTools is supplied', async () => {
    const weatherFlow = JSON.stringify({
      name: 'weather-flow',
      description: 'Call the plugin weather server.',
      start: 'go',
      nodes: [
        {
          kind: 'action',
          id: 'go',
          tool: 'weather',
          next: { end: 'done' },
        },
      ],
    });
    const fs = await pluginWith({
      '/plugin/mcp.json': MCP,
      '/plugin/flows/weather.flow.json': weatherFlow,
    });

    const allowed = await loadAgentPlugin(fs, '/plugin', { hostTools: [] });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.plugin.flows.map((flow) => flow.name)).toEqual(['weather-flow']);
    expect(allowed.plugin.diagnostics).toEqual([]);

    const withOtherHostTool = await loadAgentPlugin(fs, '/plugin', {
      hostTools: ['lookup'],
    });
    expect(withOtherHostTool.ok).toBe(true);
    if (!withOtherHostTool.ok) return;
    expect(withOtherHostTool.plugin.flows.map((flow) => flow.name)).toEqual([
      'weather-flow',
    ]);
  });

  it('skips a flow that fails the envelope schema with one flows diagnostic', async () => {
    const fs = await pluginWith({
      '/plugin/flows/greet.flow.json': GREET_FLOW,
      '/plugin/flows/nonesuch.flow.json': JSON.stringify({ name: 'nonesuch' }),
    });

    const result = await loadAgentPlugin(fs, '/plugin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plugin.flows.map((flow) => flow.name)).toEqual(['greet']);
    expect(
      result.plugin.diagnostics.map((d) => [d.section, d.rule, d.origin]),
    ).toEqual([['flows', 'flow-schema-invalid', 'flows/nonesuch.flow.json']]);
  });

  it('emits no diagnostics when flows/ is absent', async () => {
    const fs = await pluginWith({});
    const result = await loadAgentPlugin(fs, '/plugin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plugin.flows).toEqual([]);
    expect(result.plugin.diagnostics).toEqual([]);
  });
});
