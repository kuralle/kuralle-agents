import { realpath } from 'node:fs/promises';
import { resolve as hostResolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { containsResolvedPath } from '@kuralle-agents/fs';
import type { Diagnostic, McpServerConfig } from '@kuralle-agents/plugins';
import { connectionFailureDiagnostic } from '../connect.js';
import { createConnectedServer } from '../connected-server.js';
import type { ConnectedMcpServer, StdioConnectorOptions } from '../types.js';
import { authFailureDiagnostic, authStatusFromError } from '../headers.js';
import { registerStdioConnector } from '../mcp-tools.js';
import { ensureWritableDataDirectory } from './plugin-data.js';
import { composeSubprocessEnvironment } from './subprocess-env.js';

const CLIENT_INFO = { name: 'kuralle-agents', version: '0.20.0' };

/**
 * Maps a path inside a `FileSystem` onto the host path a subprocess can actually be
 * started from.
 *
 * A plugin loaded through `new NodeFileSystem('/srv/plugins')` reports its root as
 * `/my-plugin`, not `/srv/plugins/my-plugin`. Those virtual paths are correct everywhere in
 * `@kuralle-agents/plugins`, which is filesystem-agnostic by design — but `posix_spawn`
 * takes host paths, so the translation has to happen somewhere, and this Node-only
 * connector is the only place that both knows the host and is allowed to care.
 *
 * Detected structurally rather than by importing `NodeFileSystem`, which would pull a
 * Node-backed implementation into a module the root export must not reach.
 */
function toHostPath(
  fs: unknown,
  virtualPath: string | undefined,
): string | undefined {
  if (virtualPath === undefined) {
    return undefined;
  }
  const root = (fs as { root?: unknown } | undefined)?.root;
  if (typeof root !== 'string') {
    // Not a host-backed filesystem: the path is already whatever the caller meant.
    return virtualPath;
  }
  return hostResolve(root, `.${virtualPath}`);
}

/**
 * Rebases a value the parser expanded against the virtual roots onto the host roots.
 *
 * §9.2 expansion happens at parse time, in a package with no notion of a host path, so
 * `args` and `env` come back carrying virtual roots. `command` and `cwd` are declared
 * paths and get mapped directly; these are opaque strings under §4.1(5), so the only sound
 * transformation is to replace the exact roots the parser itself substituted.
 */
function rebaseExpandedRoots(
  value: string,
  roots: ReadonlyArray<{ virtual: string; host: string }>,
): string {
  // Longest root first, so `/data/x` wins over `/x`, and return on the first match.
  // Substituting every occurrence in sequence re-substitutes text the previous pass just
  // introduced — the same hazard §9.2 guards against when it forbids rescanning expanded
  // text. Only a value *rooted* at one of these is a path we may rewrite.
  for (const { virtual, host } of [...roots].sort(
    (a, b) => b.virtual.length - a.virtual.length,
  )) {
    if (value === virtual) {
      return host;
    }
    if (value.startsWith(`${virtual}/`)) {
      return host + value.slice(virtual.length);
    }
  }
  return value;
}

/**
 * §4.1(3) resolves containment through symlinks, and the host filesystem is where that
 * resolution has to happen: `posix_spawn` follows the real links, not whatever a virtual
 * `FileSystem` would report. `containsResolvedPath` is the canonical check; only the
 * `realpath` it calls is host-bound.
 */
const HOST_FS = { realpath: (path: string) => realpath(path) };

/**
 * §4.1(4): a `command` or `cwd` that fails containment makes the entry invalid.
 *
 * This runs at launch rather than at parse. §4.1(3) demands a filesystem-resolved check,
 * and §7.2.1 permits `cwd: "${PLUGIN_DATA}"` — a directory the client must create *before
 * launching*, so at parse time it reliably does not exist and `realpath` would reject the
 * specification's own example. Parse keeps its lexical check for `../` escapes; this is the
 * first moment both paths genuinely exist, so it is where symlinks get caught.
 */
async function checkDeclaredPaths(
  config: Extract<McpServerConfig, { type: 'stdio' }>,
  paths: {
    command: string;
    cwd: string | undefined;
    pluginRoot: string | undefined;
    pluginDataRoot: string | undefined;
  },
): Promise<Diagnostic | null> {
  const escaped = (what: string, value: string): Diagnostic => ({
    section: '4.1',
    rule: 'path-escapes-plugin-root',
    origin: config.name,
    message:
      `stdio MCP server "${config.name}" ${what} "${value}" resolves outside its ` +
      'permitted root once symlinks are followed; the server entry is skipped.',
  });

  // §4.1(5): a bare command goes through platform search and is an opaque string, not a
  // package path. Only a plugin-relative one was ever claimed to live inside the plugin.
  //
  // By this point the parser has already resolved a `./…` declaration to an absolute path
  // and left a bare token alone, so "absolute" *is* "was plugin-relative". Testing for a
  // leading `./` here looks right and never fires — the first version of this guard did,
  // and let the escaping symlink straight through.
  const commandIsPluginRelative = config.command.startsWith('/');
  if (commandIsPluginRelative && paths.pluginRoot !== undefined) {
    if (!(await containsResolvedPath(HOST_FS, paths.pluginRoot, paths.command))) {
      return escaped('command', config.command);
    }
  }

  if (paths.cwd !== undefined) {
    const root =
      config.cwdRoot === 'data' ? paths.pluginDataRoot : paths.pluginRoot;
    if (root !== undefined && !(await containsResolvedPath(HOST_FS, root, paths.cwd))) {
      return escaped('working directory', config.cwd ?? paths.cwd);
    }
  }

  return null;
}

async function connectStdioServer(
  config: Extract<McpServerConfig, { type: 'stdio' }>,
  opts: StdioConnectorOptions,
): Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }> {
  const pluginRoot = toHostPath(opts.fs, config.pluginRoot);
  const pluginDataRoot = toHostPath(opts.fs, config.pluginDataRoot);
  const cwd = toHostPath(opts.fs, config.cwd);
  const command = config.command.startsWith('/')
    ? (toHostPath(opts.fs, config.command) as string)
    : config.command;

  // §9.1: the client MUST create PLUGIN_DATA before launching, and make it writable.
  // Done here rather than at load, because this is the only path that spawns — a Worker
  // never reaches it, so nothing writes on a runtime that cannot use the directory.
  if (pluginDataRoot !== undefined) {
    const dataFailure = await ensureWritableDataDirectory(config.name, pluginDataRoot);
    if (dataFailure) {
      return { diagnostic: dataFailure };
    }
  }

  // After the PLUGIN_DATA mkdir — a `cwd` of `${PLUGIN_DATA}` has to exist to be resolved
  // — and before anything is spawned.
  const containmentFailure = await checkDeclaredPaths(config, {
    command,
    cwd,
    pluginRoot,
    pluginDataRoot,
  });
  if (containmentFailure) {
    return { diagnostic: containmentFailure };
  }

  const roots = [
    { virtual: config.pluginDataRoot, host: pluginDataRoot },
    { virtual: config.pluginRoot, host: pluginRoot },
  ].filter(
    (pair): pair is { virtual: string; host: string } =>
      typeof pair.virtual === 'string' && typeof pair.host === 'string',
  );

  const pluginEnv = config.env
    ? Object.fromEntries(
        Object.entries(config.env).map(([name, value]) => [
          name,
          rebaseExpandedRoots(value, roots),
        ]),
      )
    : undefined;

  const transport = new StdioClientTransport({
    command,
    args: config.args?.map((arg) => rebaseExpandedRoots(arg, roots)),
    env: composeSubprocessEnvironment({
      pluginEnv,
      pluginRoot,
      pluginDataRoot,
    }),
    cwd,
  });
  const client = new Client(CLIENT_INFO);

  try {
    await client.connect(transport, { timeout: opts.timeoutMs });
  } catch (error) {
    await transport.close().catch(() => undefined);
    const authStatus = authStatusFromError(error);
    if (authStatus) {
      return { diagnostic: authFailureDiagnostic(config.name, authStatus) };
    }
    const message =
      error instanceof Error ? error.message : 'MCP stdio connection failed.';
    return { diagnostic: connectionFailureDiagnostic(config.name, message) };
  }

  void client.getInstructions();

  return {
    server: createConnectedServer(client, {
      serverName: config.name,
      timeoutMs: opts.timeoutMs,
    }),
  };
}

registerStdioConnector(connectStdioServer);
