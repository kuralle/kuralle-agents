import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { InMemoryFs } from '@kuralle-agents/fs';
import { mcpTools, type Diagnostic as McpDiagnostic } from '@kuralle-agents/mcp';
import { loadAgentPlugin } from '../src/index.js';

/**
 * Cloudflare Workers parity for the plugin loader.
 *
 * `@kuralle-agents/plugins` depends only on core and fs, so it is plausibly workerd-clean —
 * but plausible is not proven, and nothing here ever ran under workerd before. These tests
 * exist to catch a transitive import that breaks the module graph, and to pin the shape a
 * real deployment actually meets: a published plugin carrying both skills and a stdio
 * server, on a runtime that can only run half of it.
 */

const MANIFEST = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'workers-parity',
  description: 'Loaded inside workerd.',
});

const SKILL = `---
name: summarize
description: Summarize a document into three bullet points.
---

# Summarize

Produce exactly three bullets.
`;

async function buildPlugin(options: { mcp?: string } = {}): Promise<InMemoryFs> {
  const fs = new InMemoryFs();
  await fs.mkdir('/plugin/skills/summarize', { recursive: true });
  await fs.writeFile('/plugin/plugin.json', MANIFEST);
  await fs.writeFile('/plugin/skills/summarize/SKILL.md', SKILL);
  if (options.mcp) {
    await fs.writeFile('/plugin/mcp.json', options.mcp);
  }
  return fs;
}

describe('plugin loader under workerd', () => {
  it('loads a plugin from a non-Node FileSystem', async () => {
    const fs = await buildPlugin();
    const result = await loadAgentPlugin(fs, '/plugin');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plugin.manifest.name).toBe('workers-parity');
    const skills = await result.plugin.skills.list();
    expect(skills.map((skill) => skill.name)).toEqual(['summarize']);
  });

  it('takes the half it can run when a plugin declares a stdio server', async () => {
    // The normal shape of a published plugin on Workers. §11.2 permits a client to support
    // one component type; §11.3 requires an isolated failure not to sink the rest. So the
    // skills must load, the plugin must not be rejected, and only the stdio entry drops.
    const fs = await buildPlugin({
      mcp: JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          local: { type: 'stdio', command: 'some-server' },
          remote: { type: 'streamable-http', url: 'https://tools.example.com/mcp' },
        },
      }),
    });

    const result = await loadAgentPlugin(fs, '/plugin');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Parsing keeps both entries — the transport limit is the client's, not the package's.
    expect(result.plugin.mcpServers.map((server) => server.name).sort()).toEqual([
      'local',
      'remote',
    ]);
    const skills = await result.plugin.skills.list();
    expect(skills.map((skill) => skill.name)).toEqual(['summarize']);

    // Connecting is where the runtime limit bites, and only for the stdio entry.
    const diagnostics: McpDiagnostic[] = [];
    const toolset = await mcpTools(
      result.plugin.mcpServers.filter((server) => server.type === 'stdio'),
      { onDiagnostic: (d) => diagnostics.push(d) },
    );

    try {
      expect(Object.keys(toolset.tools)).toEqual([]);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.rule).toBe('unsupported-transport');
      expect(diagnostics[0]!.origin).toBe('local');
      expect(diagnostics[0]!.message).toMatch(/workers|workerd|cloudflare/i);
    } finally {
      await toolset.close();
    }
  });

  it('reports a corrupt mcp.json without losing the skills', async () => {
    // §7.2.2 rule 2: a bad top-level mcp.json disables MCP for the plugin and nothing else.
    const fs = await buildPlugin({ mcp: '{ not json' });
    const result = await loadAgentPlugin(fs, '/plugin');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plugin.mcpServers).toEqual([]);
    const skills = await result.plugin.skills.list();
    expect(skills.map((skill) => skill.name)).toEqual(['summarize']);
    expect(
      result.plugin.diagnostics.some((d) => d.rule === 'mcp-config-invalid'),
    ).toBe(true);
  });

  it('resolves containment through a symlink inside workerd', async () => {
    // `containsResolvedPath` calls `FileSystem.realpath`. InMemoryFs implements it, but the
    // guard had only ever run against NodeFileSystem — this pins that the §4.1(3) check
    // behaves on the runtime a Cloudflare deployment actually uses.
    const fs = new InMemoryFs();
    await fs.mkdir('/plugin/nested', { recursive: true });
    await fs.mkdir('/outside', { recursive: true });
    await fs.writeFile('/outside/smuggled.json', MANIFEST);
    await fs.symlink('../outside/smuggled.json', '/plugin/plugin.json');

    const result = await loadAgentPlugin(fs, '/plugin');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.section).toBe('4.1');
    expect(result.rejection.rule).toBe('path-escapes-plugin-root');
  });
});

describe('plugin loader on the durable Cloudflare filesystem', () => {
  it('loads a plugin from Durable Object SQLite', async () => {
    // InMemoryFs proves the loader is filesystem-agnostic; this proves it works on the
    // backend a real deployment actually runs — DO SQLite via SqlFileSystem.
    const ns = (env as unknown as { PLUGIN_DO: DurableObjectNamespace }).PLUGIN_DO;
    const stub = ns.get(ns.idFromName('parity'));
    const body = (await (await stub.fetch('http://do/load')).json()) as {
      ok: boolean;
      name?: string;
      skills?: string[];
      mcpServers?: string[];
      diagnostics?: string[];
    };

    expect(body.ok).toBe(true);
    expect(body.name).toBe('workers-parity-sql');
    expect(body.skills).toEqual(['summarize']);
    expect(body.mcpServers).toEqual(['remote']);
    expect(body.diagnostics).toEqual([]);
  });
});
