/**
 * The base environment a stdio MCP subprocess starts from.
 *
 * Agent Plugins §9.1 leaves this to the client: inherit, omit, or sanitize. We sanitize —
 * start empty, add a fixed set, then the plugin's own `env`, then the reserved variables
 * last. Recorded in the Decision document "stdio MCP subprocesses start from a sanitized
 * environment allowlist".
 *
 * It fails closed. An omission breaks a plugin loudly at connect; inheriting would put
 * every ambient credential in the host process in front of third-party code.
 *
 * This is not a sandbox and must not be described as one — §4.1 says so plainly. `HOME` is
 * here knowing it points at `~/.aws` and `~/.ssh`; the subprocess can reach those anyway,
 * so withholding it would break npm and buy nothing.
 */
const BASE_ENVIRONMENT_NAMES = [
  // Bare-command resolution: npx, uvx, node, python.
  'PATH',
  // npm's .npmrc and cache.
  'HOME',
  'TMPDIR',
  // Locale-dependent encoding. A Python server with none mangles non-ASCII output.
  'LANG',
  'LC_ALL',
  // Windows equivalents of the above.
  'SystemRoot',
  'PATHEXT',
  'APPDATA',
] as const;

export function baseSubprocessEnvironment(
  ambient: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of BASE_ENVIRONMENT_NAMES) {
    const value = ambient[name];
    if (typeof value === 'string') {
      base[name] = value;
    }
  }
  return base;
}

/**
 * Composes the subprocess environment in the order §9.1 requires: base, then the plugin's
 * expanded entries, then the reserved variables — which the client always supplies and a
 * plugin may never override.
 */
export function composeSubprocessEnvironment(args: {
  pluginEnv?: Record<string, string>;
  pluginRoot?: string;
  pluginDataRoot?: string;
  ambient?: Record<string, string | undefined>;
}): Record<string, string> {
  const env: Record<string, string> = {
    ...baseSubprocessEnvironment(args.ambient),
    ...(args.pluginEnv ?? {}),
  };

  if (args.pluginRoot !== undefined) {
    env.PLUGIN_ROOT = args.pluginRoot;
  }
  if (args.pluginDataRoot !== undefined) {
    env.PLUGIN_DATA = args.pluginDataRoot;
  }

  return env;
}
