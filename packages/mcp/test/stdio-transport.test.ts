import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createMockSession } from '@kuralle-agents/core/testing';
import { mcpTools } from '../src/node/index.js';
import { minimalToolContext } from './helpers/tool-context.js';

const ctx = () => minimalToolContext(createMockSession());

const FIXTURE = fileURLToPath(new URL('./helpers/stdio-fixture.ts', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./helpers', import.meta.url));

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

describe('PLUGIN_DATA directory (§9.1)', () => {
  it('skips only the server whose data directory cannot be created', async () => {
    // §7.2.2 rule 5 and §11.3: an unusable data directory is a per-server failure. The
    // plugin's other servers — and its skills — must survive it.
    const diagnostics: string[] = [];
    const { tools, close } = await mcpTools(
      [
        {
          ...stdioServer(),
          name: 'unwritable',
          // A path under a non-directory: mkdir fails deterministically on every platform.
          pluginRoot: '/dev/null/nope',
          pluginDataRoot: '/dev/null/nope/data',
        },
        { ...stdioServer(), name: 'healthy' },
      ],
      { onDiagnostic: (d) => diagnostics.push(d.message) },
    );

    try {
      // The healthy sibling still connected.
      expect(Object.keys(tools).some((n) => n.startsWith('healthy__'))).toBe(true);
      expect(Object.keys(tools).some((n) => n.startsWith('unwritable__'))).toBe(false);

      const dataFailure = diagnostics.find((m) => m.includes('PLUGIN_DATA'));
      expect(dataFailure).toBeDefined();
      // The message has to name the requirement, or it reads as a random mkdir error.
      expect(dataFailure).toMatch(/§9\.1/);
    } finally {
      await close();
    }
  }, 30_000);

  it('creates the directory before the subprocess starts, not after', async () => {
    // Ordering is the whole requirement. A plugin reads PLUGIN_DATA on its first line.
    const { rmSync, existsSync } = await import('node:fs');
    const dataRoot = `${FIXTURE_DIR}/probe-data-${Date.now()}`;
    rmSync(dataRoot, { recursive: true, force: true });

    const { close } = await mcpTools(
      [{ ...stdioServer(), pluginRoot: FIXTURE_DIR, pluginDataRoot: dataRoot }],
      {},
    );

    try {
      expect(existsSync(dataRoot)).toBe(true);
    } finally {
      await close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
