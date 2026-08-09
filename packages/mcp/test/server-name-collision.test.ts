import { describe, expect, it } from 'bun:test';
import { createMockSession } from '@kuralle-agents/core/testing';
import { z } from 'zod';
import { mcpTools } from '../src/index.js';
import { startStubMcpServer } from './helpers/stub-server.js';
import { minimalToolContext } from './helpers/tool-context.js';

const ctx = () => minimalToolContext(createMockSession());

/**
 * A server name is only unique inside one `mcp.json`. Agent Plugins has no global registry
 * — §5.5 constrains a plugin name's character set, not its uniqueness — so two
 * independently authored plugins both calling a server `local` is the expected case.
 *
 * It used to lose one of them silently: `liveByServer` was keyed by the bare name, so the
 * second connection overwrote the first and its tools never reached the model.
 */

function whoami(id: string) {
  return {
    name: 'whoami',
    description: `Identifies which server answered`,
    inputSchema: z.object({}),
    handler: () => id,
  };
}

describe('two plugins declaring the same server name', () => {
  it('keeps both servers reachable, each routing to its own backend', async () => {
    const alpha = startStubMcpServer({ tools: [whoami('alpha')] });
    const beta = startStubMcpServer({ tools: [whoami('beta')] });
    const diagnostics: string[] = [];

    const { tools, close } = await mcpTools(
      [
        { name: 'local', type: 'streamable-http', url: alpha.url },
        { name: 'local', type: 'streamable-http', url: beta.url },
      ],
      { allowedHosts: ['127.0.0.1'], onDiagnostic: (d) => diagnostics.push(d.rule) },
    );

    try {
      const names = Object.keys(tools).filter((n) => n.endsWith('__whoami'));
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);

      // Routing is the real property. Two distinct names that both hit the same backend
      // would satisfy a count assertion and still be broken.
      const answers = new Set<string>();
      for (const name of names) {
        answers.add(String(await tools[name]!.execute({}, ctx())));
      }
      expect(answers).toEqual(new Set(['alpha', 'beta']));

      expect(diagnostics).toContain('server-name-collision');
    } finally {
      await close();
      alpha.close();
      beta.close();
    }
  }, 20_000);

  it('leaves a name alone when nothing collides', async () => {
    // The discriminator. Suffixing unconditionally would also make the test above pass,
    // and would break every `Policy` rule written against a plain `server__tool` name.
    const only = startStubMcpServer({ tools: [whoami('solo')] });

    const { tools, close } = await mcpTools(
      [{ name: 'local', type: 'streamable-http', url: only.url }],
      { allowedHosts: ['127.0.0.1'] },
    );

    try {
      expect(Object.keys(tools)).toEqual(['local__whoami']);
    } finally {
      await close();
      only.close();
    }
  }, 20_000);

  it('gives a server the same projected name whichever order it is loaded in', async () => {
    // Load order is the caller's accident. If it decided which server kept the plain name,
    // a `Policy` rule would silently start matching a different backend when a plugin list
    // was reordered — so both are suffixed, keyed on identity rather than position.
    const alpha = startStubMcpServer({ tools: [whoami('alpha')] });
    const beta = startStubMcpServer({ tools: [whoami('beta')] });

    const project = async (first: string, second: string) => {
      const { tools, close } = await mcpTools(
        [
          { name: 'local', type: 'streamable-http', url: first },
          { name: 'local', type: 'streamable-http', url: second },
        ],
        { allowedHosts: ['127.0.0.1'] },
      );
      const byAnswer: Record<string, string> = {};
      for (const name of Object.keys(tools).filter((n) => n.endsWith('__whoami'))) {
        byAnswer[String(await tools[name]!.execute({}, ctx()))] = name;
      }
      await close();
      return byAnswer;
    };

    try {
      const forward = await project(alpha.url, beta.url);
      const reversed = await project(beta.url, alpha.url);
      expect(reversed).toEqual(forward);
    } finally {
      alpha.close();
      beta.close();
    }
  }, 30_000);
});
