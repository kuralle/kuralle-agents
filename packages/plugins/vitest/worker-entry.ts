import { DurableObject } from 'cloudflare:workers';
import { sqlFileSystem } from '@kuralle-agents/fs';
import { loadAgentPlugin } from '../src/index.js';

const MANIFEST = JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'workers-parity-sql',
  description: 'Loaded from Durable Object SQLite.',
});

const SKILL = `---
name: summarize
description: Summarize a document into three bullet points.
---

# Summarize
`;

/**
 * Loads a plugin from the filesystem a real Cloudflare deployment would use: the Durable
 * Object's SQLite storage, not an in-memory stand-in.
 */
export class PluginLoaderDO extends DurableObject {
  async fetch(): Promise<Response> {
    const fs = sqlFileSystem((this.ctx.storage as { sql: unknown }).sql as never);

    await fs.mkdir('/plugin/skills/summarize', { recursive: true });
    await fs.writeFile('/plugin/plugin.json', MANIFEST);
    await fs.writeFile('/plugin/skills/summarize/SKILL.md', SKILL);
    await fs.writeFile(
      '/plugin/mcp.json',
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          remote: { type: 'streamable-http', url: 'https://tools.example.com/mcp' },
        },
      }),
    );

    const result = await loadAgentPlugin(fs, '/plugin');
    if (!result.ok) {
      return Response.json({ ok: false, rejection: result.rejection });
    }

    return Response.json({
      ok: true,
      name: result.plugin.manifest.name,
      skills: (await result.plugin.skills.list()).map((skill) => skill.name),
      mcpServers: result.plugin.mcpServers.map((server) => server.name),
      diagnostics: result.plugin.diagnostics.map((d) => d.rule),
    });
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response('kuralle-plugins test worker');
  },
};
