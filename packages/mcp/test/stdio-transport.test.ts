import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/node/index.js';
import { minimalToolContext } from './helpers/tool-context.js';

const ctx = () => minimalToolContext(createMockSession());

const FIXTURE = fileURLToPath(new URL('./helpers/stdio-fixture.ts', import.meta.url));

function stdioServer() {
  return {
    name: 'local',
    type: 'stdio' as const,
    command: process.execPath,
    args: [FIXTURE],
  };
}

describe('stdio transport shares the one result adapter', () => {
  it('surfaces a tool execution error instead of returning it as a successful value', async () => {
    // This is the finding. The stdio connector had its own `callTool` that never checked
    // `isError`, so this call resolved with the server's error text. The model was told it
    // succeeded and the durable journal recorded a success, so a replay would skip a call
    // that never worked. Remote transports were fixed; stdio was not, because it was a
    // second implementation.
    const { tools, close } = await mcpTools([stdioServer()]);

    try {
      await expect(
        tools['local__book']!.execute({ date: '1999-01-01' }, ctx()),
      ).rejects.toThrow(/must be in the future/);
    } finally {
      await close();
    }
  }, 20_000);

  it('still returns an ordinary result unchanged', async () => {
    const { tools, close } = await mcpTools([stdioServer()]);

    try {
      expect(await tools['local__echo']!.execute({ message: 'over stdio' }, ctx())).toBe(
        'over stdio',
      );
    } finally {
      await close();
    }
  }, 20_000);

  it('honours timeoutMs rather than a hardcoded default', async () => {
    // The stdio copy ignored `opts.timeoutMs` and hardcoded 60s. A 1ms budget must fail
    // the connection fast, which it cannot do if the option is dropped on the floor.
    const diagnostics: string[] = [];
    const { tools, close } = await mcpTools([stdioServer()], {
      timeoutMs: 1,
      onDiagnostic: (d) => diagnostics.push(d.message),
    });

    try {
      expect(Object.keys(tools)).toEqual([]);
      expect(diagnostics).toHaveLength(1);
    } finally {
      await close();
    }
  }, 20_000);
});
