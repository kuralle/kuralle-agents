import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockSession } from '@kuralle-agents/core/testing';
import { NodeFileSystem } from '@kuralle-agents/fs/node/fs';
import { loadAgentPlugin } from '@kuralle-agents/plugins';
import { mcpTools } from '../src/node/index.js';
import type { McpToolset } from '../src/index.js';
import { minimalToolContext } from './helpers/tool-context.js';

/**
 * Launch-level Agent Plugins conformance.
 *
 * The 25-fixture corpus in `packages/plugins` is parse-level and loads every plugin into an
 * `InMemoryFs`, so it structurally cannot spawn a subprocess. Nothing anywhere launches a
 * stdio server *from a plugin*, which is why four §7.2.1 / §9.1 MUSTs are unmet against a
 * fully green suite.
 *
 * This file lives in `packages/mcp` rather than `packages/plugins` because `packages/mcp`
 * already depends on `packages/plugins`; the reverse would be a dependency cycle.
 */

const FIXTURES = dirname(fileURLToPath(new URL('./fixtures/x', import.meta.url)));
const PLUGIN_ROOT_VIRTUAL = '/launch-env-plugin';

interface ObservedEnvironment {
  PLUGIN_ROOT: string | null;
  PLUGIN_DATA: string | null;
  cwd: string;
  argv: string[];
}

let toolset: McpToolset | undefined;
let observed: ObservedEnvironment | undefined;
let launchError: string | undefined;
let diagnostics: string[] = [];

beforeAll(async () => {
  const fs = new NodeFileSystem(FIXTURES);
  const loaded = await loadAgentPlugin(fs, PLUGIN_ROOT_VIRTUAL);
  if (!loaded.ok) {
    launchError = `loadAgentPlugin rejected: ${loaded.rejection.message}`;
    return;
  }

  toolset = await mcpTools(loaded.plugin.mcpServers, {
    onDiagnostic: (d) => diagnostics.push(d.message),
  });

  const report = toolset.tools['local__report_env'];
  if (!report) {
    launchError =
      `stdio server did not connect; diagnostics: ${diagnostics.join(' | ') || '(none)'}`;
    return;
  }

  const raw = await report.execute({}, minimalToolContext(createMockSession()));
  observed = JSON.parse(String(raw)) as ObservedEnvironment;
}, 30_000);

afterAll(async () => {
  await toolset?.close();
});

describe('Agent Plugins launch conformance', () => {
  it('resolves a plugin-relative ./bin command and starts the subprocess', () => {
    // §7.2.1: a plugin-relative command MUST resolve against the plugin root. Today the raw
    // './bin/echo-env' string reaches StdioClientTransport and resolves against the host
    // process cwd instead, so the server never starts.
    expect(launchError).toBeUndefined();
    expect(observed).toBeDefined();
  });

  it('supplies PLUGIN_ROOT to the subprocess', () => {
    // §9.1, §11.1(6).
    expect(observed?.PLUGIN_ROOT).toBeTruthy();
  });

  it('supplies a PLUGIN_DATA directory that exists and is writable', async () => {
    // §9.1: the client MUST create it before launching, and make it writable.
    const dataRoot = observed?.PLUGIN_DATA;
    expect(dataRoot).toBeTruthy();

    const probe = `${dataRoot}/.write-probe`;
    await Bun.write(probe, 'ok');
    expect(await Bun.file(probe).text()).toBe('ok');
    await Bun.$`rm -f ${probe}`.quiet();
  });

  it('starts the subprocess in the plugin root, not the host working directory', () => {
    // §7.2.1: when `cwd` is omitted the client MUST use the plugin root.
    expect(observed?.cwd).toBeTruthy();
    expect(observed?.cwd).not.toBe(process.cwd());
    expect(observed?.cwd).toBe(observed?.PLUGIN_ROOT);
  });
});
