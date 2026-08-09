import { containsPath, dirname, normalizePath, resolvePath } from '@kuralle-agents/fs';
import type { Diagnostic, McpServerConfig } from './types.js';
import { diagnostic as makeDiagnostic, isPlainObject } from './diagnostics.js';

const MCP_FILE = 'mcp.json';
const MCP_ORIGIN = 'mcp.json';

const SUPPORTED_MCP_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const AGENT_PLUGINS_MCP_SCHEMA_PATTERN =
  /^https:\/\/agent-plugins\.org\/schemas\/[^/]+\/mcp\.schema\.json$/;

const AGENT_PLUGINS_VERSION_PATTERN =
  /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\/(?:plugin|mcp)\.schema\.json$/;

const CWD_PATTERN =
  /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

const SECRET_KEY_PATTERN = /(^|_)(api[_-]?key|token|secret|password)$/i;

const SECRET_VALUE_PREFIX_PATTERN = /^(sk-|fc-|ghp_|gho_|xox[baprs]-)/i;

const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const REMOTE_FIELDS = new Set(['type', 'url', 'headers']);

export interface LoadMcpResult {
  mcpServers: McpServerConfig[];
  diagnostics: Diagnostic[];
}

function diagnostic(section: string, rule: string, message: string): Diagnostic {
  return makeDiagnostic(section, rule, MCP_ORIGIN, message);
}

function extractSchemaVersion(schema: string): string | null {
  const match = AGENT_PLUGINS_VERSION_PATTERN.exec(schema);
  return match ? match[1] : null;
}

const PLACEHOLDER_PATTERN = /\$\{PLUGIN_(ROOT|DATA)\}/g;

/** Single-pass, non-recursive placeholder expansion for MCP stdio fields. */
export function expandPluginPlaceholders(
  text: string,
  pluginRoot: string,
  pluginDataRoot: string,
): string {
  return text.replace(PLACEHOLDER_PATTERN, (_match, kind: string) => {
    return kind === 'ROOT' ? pluginRoot : pluginDataRoot;
  });
}

function resolveCwd(
  cwd: string,
  pluginRoot: string,
  pluginDataRoot: string,
): string {
  const expanded = expandPluginPlaceholders(cwd, pluginRoot, pluginDataRoot);

  if (expanded.startsWith('./')) {
    return resolvePath(pluginRoot, expanded.slice(2));
  }

  const pluginRootNorm = normalizePath(pluginRoot);
  const pluginDataNorm = normalizePath(pluginDataRoot);

  if (expanded === pluginRootNorm) {
    return pluginRootNorm;
  }
  if (expanded.startsWith(`${pluginRootNorm}/`)) {
    return normalizePath(expanded);
  }
  if (expanded === pluginDataNorm) {
    return pluginDataNorm;
  }
  if (expanded.startsWith(`${pluginDataNorm}/`)) {
    return normalizePath(expanded);
  }

  return normalizePath(expanded);
}

function validateCommand(
  command: string,
  pluginRoot: string,
): Diagnostic | null {
  if (command.length === 0) {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      'stdio server "command" must be a non-empty string.',
    );
  }

  const hasPathSeparator = command.includes('/') || command.includes('\\');

  if (!hasPathSeparator) {
    return null;
  }

  if (!command.startsWith('./')) {
    return diagnostic(
      '4.1',
      'path-escapes-plugin-root',
      `stdio server command "${command}" is not a bare executable or plugin-relative path.`,
    );
  }

  const resolved = resolvePath(pluginRoot, command.slice(2));
  if (!containsPath(pluginRoot, resolved)) {
    return diagnostic(
      '4.1',
      'path-escapes-plugin-root',
      `stdio server command "${command}" resolves outside the plugin root.`,
    );
  }

  return null;
}

function validateCwd(
  cwd: unknown,
  pluginRoot: string,
  pluginDataRoot: string,
): Diagnostic | null {
  if (cwd === undefined) {
    return null;
  }

  if (typeof cwd !== 'string' || cwd.length === 0) {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      'stdio server "cwd" must be a non-empty string.',
    );
  }

  if (!CWD_PATTERN.test(cwd)) {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      `stdio server "cwd" value "${cwd}" is not a permitted form.`,
    );
  }

  const resolved = resolveCwd(cwd, pluginRoot, pluginDataRoot);
  const expanded = expandPluginPlaceholders(cwd, pluginRoot, pluginDataRoot);
  const pluginRootNorm = normalizePath(pluginRoot);
  const pluginDataNorm = normalizePath(pluginDataRoot);

  const rootedInPlugin =
    expanded.startsWith('./') ||
    expanded === '${PLUGIN_ROOT}' ||
    expanded.startsWith('${PLUGIN_ROOT}/') ||
    resolved === pluginRootNorm ||
    resolved.startsWith(`${pluginRootNorm}/`);

  const rootedInData =
    expanded === '${PLUGIN_DATA}' ||
    expanded.startsWith('${PLUGIN_DATA}/') ||
    resolved === pluginDataNorm ||
    resolved.startsWith(`${pluginDataNorm}/`);

  const containmentRoot = rootedInPlugin
    ? pluginRoot
    : rootedInData
      ? pluginDataRoot
      : null;

  if (containmentRoot === null || !containsPath(containmentRoot, resolved)) {
    return diagnostic(
      '7.2.1',
      'path-escapes-plugin-root',
      `stdio server "cwd" value "${cwd}" resolves outside its permitted root.`,
    );
  }

  return null;
}

function hasDuplicateHeaderNames(
  headers: Record<string, string>,
): boolean {
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return true;
    }
    seen.add(lower);
  }
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') {
    return true;
  }

  if (hostname.includes(':')) {
    const normalized = hostname.replace(/^\[|\]$/g, '');
    return normalized === '::1' || normalized.startsWith('0:0:0:0:0:0:0:1');
  }

  if (/^127\.(\d{1,3}\.){2}\d{1,3}$/.test(hostname)) {
    return true;
  }

  return false;
}

function validateRemoteUrl(url: string): Diagnostic | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return diagnostic(
      '7.2.1',
      'server-entry-invalid',
      `Remote MCP server URL "${url}" is not a valid absolute URL.`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return diagnostic(
      '7.2.1',
      'server-entry-invalid',
      `Remote MCP server URL "${url}" must use http or https.`,
    );
  }

  if (parsed.username || parsed.password) {
    return diagnostic(
      '7.2.1',
      'server-entry-invalid',
      `Remote MCP server URL "${url}" must not contain user information.`,
    );
  }

  if (parsed.hash.length > 0) {
    return diagnostic(
      '7.2.1',
      'server-entry-invalid',
      `Remote MCP server URL "${url}" must not contain a fragment.`,
    );
  }

  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return diagnostic(
      '7.2.1',
      'server-entry-invalid',
      `Remote MCP server URL "${url}" must use https for non-loopback hosts.`,
    );
  }

  return null;
}

function looksLikeSecret(key: string, value: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) {
    return true;
  }
  return SECRET_VALUE_PREFIX_PATTERN.test(value);
}

function validateEnv(
  env: unknown,
  pluginRoot: string,
  pluginDataRoot: string,
  diagnostics: Diagnostic[],
): Record<string, string> | null | undefined {
  if (env === undefined) {
    return undefined;
  }

  if (!isPlainObject(env)) {
    return null;
  }

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') {
      return null;
    }
    if (typeof value !== 'string') {
      return null;
    }
    if (looksLikeSecret(key, value)) {
      diagnostics.push(
        diagnostic(
          '9.2',
          'secret-in-env',
          `Environment value for "${key}" appears to contain a credential.`,
        ),
      );
    }
    result[key] = expandPluginPlaceholders(value, pluginRoot, pluginDataRoot);
  }

  return result;
}

function hasUnknownFields(
  entry: Record<string, unknown>,
  allowed: Set<string>,
): boolean {
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) {
      return true;
    }
  }
  return false;
}

function parseStdioServer(
  name: string,
  entry: Record<string, unknown>,
  pluginRoot: string,
  pluginDataRoot: string,
  diagnostics: Diagnostic[],
): McpServerConfig | Diagnostic {
  if (hasUnknownFields(entry, STDIO_FIELDS)) {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      `MCP server "${name}" contains unknown or cross-variant fields.`,
    );
  }

  if (typeof entry.command !== 'string') {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      `stdio MCP server "${name}" is missing a valid "command" field.`,
    );
  }

  const commandFailure = validateCommand(entry.command, pluginRoot);
  if (commandFailure) {
    return commandFailure;
  }

  const cwdFailure = validateCwd(entry.cwd, pluginRoot, pluginDataRoot);
  if (cwdFailure) {
    return cwdFailure;
  }

  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args)) {
      return diagnostic(
        '7.2.2',
        'server-entry-invalid',
        `stdio MCP server "${name}" has an invalid "args" field.`,
      );
    }
    for (const arg of entry.args) {
      if (typeof arg !== 'string') {
        return diagnostic(
          '7.2.2',
          'server-entry-invalid',
          `stdio MCP server "${name}" has a non-string "args" entry.`,
        );
      }
    }
  }

  const envDiagnostics: Diagnostic[] = [];
  const env = validateEnv(
    entry.env,
    pluginRoot,
    pluginDataRoot,
    envDiagnostics,
  );
  if (env === null) {
    if (
      isPlainObject(entry.env) &&
      ('PLUGIN_ROOT' in entry.env || 'PLUGIN_DATA' in entry.env)
    ) {
      return diagnostic(
        '9.2',
        'env-reserved-name',
        `stdio MCP server "${name}" uses a reserved environment variable name.`,
      );
    }
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      `stdio MCP server "${name}" has an invalid "env" field.`,
    );
  }
  diagnostics.push(...envDiagnostics);

  const config: McpServerConfig = {
    name,
    type: 'stdio',
    command: entry.command,
  };

  if (entry.args !== undefined) {
    config.args = (entry.args as string[]).map((arg) =>
      expandPluginPlaceholders(arg, pluginRoot, pluginDataRoot),
    );
  }

  if (env !== undefined) {
    config.env = env;
  }

  if (entry.cwd !== undefined && typeof entry.cwd === 'string') {
    config.cwd = expandPluginPlaceholders(
      entry.cwd,
      pluginRoot,
      pluginDataRoot,
    );
  }

  return config;
}

function parseRemoteServer(
  name: string,
  entry: Record<string, unknown>,
  transport: 'streamable-http' | 'sse',
): McpServerConfig | Diagnostic {
  if (hasUnknownFields(entry, REMOTE_FIELDS)) {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      `MCP server "${name}" contains unknown or cross-variant fields.`,
    );
  }

  if (typeof entry.url !== 'string' || entry.url.length === 0) {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      `${transport} MCP server "${name}" is missing a valid "url" field.`,
    );
  }

  const urlFailure = validateRemoteUrl(entry.url);
  if (urlFailure) {
    return urlFailure;
  }

  if (entry.headers !== undefined) {
    if (!isPlainObject(entry.headers)) {
      return diagnostic(
        '7.2.2',
        'server-entry-invalid',
        `${transport} MCP server "${name}" has an invalid "headers" field.`,
      );
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.headers)) {
      if (typeof value !== 'string') {
        return diagnostic(
          '7.2.2',
          'server-entry-invalid',
          `${transport} MCP server "${name}" has a non-string header value.`,
        );
      }
      headers[key] = value;
    }

    if (hasDuplicateHeaderNames(headers)) {
      return diagnostic(
        '7.2.2',
        'server-entry-invalid',
        `${transport} MCP server "${name}" repeats a header name under different casing.`,
      );
    }

    return {
      name,
      type: transport,
      url: entry.url,
      headers,
    };
  }

  return {
    name,
    type: transport,
    url: entry.url,
  };
}

function parseServerEntry(
  name: string,
  entry: unknown,
  pluginRoot: string,
  pluginDataRoot: string,
  diagnostics: Diagnostic[],
): McpServerConfig | Diagnostic {
  if (!isPlainObject(entry)) {
    return diagnostic(
      '7.2.2',
      'server-entry-invalid',
      `MCP server "${name}" must be an object.`,
    );
  }

  const type = entry.type;
  if (type === 'stdio') {
    return parseStdioServer(
      name,
      entry,
      pluginRoot,
      pluginDataRoot,
      diagnostics,
    );
  }

  if (type === 'streamable-http' || type === 'sse') {
    return parseRemoteServer(name, entry, type);
  }

  return diagnostic(
    '7.2.2',
    'server-entry-invalid',
    `MCP server "${name}" declares an unsupported transport type.`,
  );
}

function disableMcp(
  section: string,
  rule: string,
  message: string,
): LoadMcpResult {
  return {
    mcpServers: [],
    diagnostics: [diagnostic(section, rule, message)],
  };
}

type TopLevelValidation =
  | { ok: true; mcpServers: Record<string, unknown> }
  | { ok: false; result: LoadMcpResult };

function validateTopLevel(
  parsed: unknown,
  manifestSchema: string,
): TopLevelValidation {
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      result: disableMcp(
        '7.2.2',
        'mcp-config-invalid',
        'mcp.json must contain a top-level object.',
      ),
    };
  }

  const permitted = new Set(['$schema', 'mcpServers']);
  for (const key of Object.keys(parsed)) {
    if (!permitted.has(key)) {
      return {
        ok: false,
        result: disableMcp(
          '7.2.2',
          'mcp-config-invalid',
          `mcp.json contains unknown top-level field "${key}".`,
        ),
      };
    }
  }

  if (typeof parsed.$schema !== 'string' || parsed.$schema.length === 0) {
    return {
      ok: false,
      result: disableMcp(
        '7.2.2',
        'mcp-config-invalid',
        'mcp.json is missing required field "$schema".',
      ),
    };
  }

  const mcpSchema = parsed.$schema;
  const manifestVersion = extractSchemaVersion(manifestSchema);
  const mcpVersion = AGENT_PLUGINS_MCP_SCHEMA_PATTERN.test(mcpSchema)
    ? extractSchemaVersion(mcpSchema)
    : null;

  if (
    manifestVersion !== null &&
    mcpVersion !== null &&
    manifestVersion !== mcpVersion
  ) {
    return {
      ok: false,
      result: disableMcp(
        '10.1',
        'mcp-config-version-mismatch',
        'mcp.json $schema version does not match plugin.json.',
      ),
    };
  }

  if (mcpSchema !== SUPPORTED_MCP_SCHEMA) {
    if (AGENT_PLUGINS_MCP_SCHEMA_PATTERN.test(mcpSchema)) {
      return {
        ok: false,
        result: disableMcp(
          '7.2.2',
          'mcp-config-invalid',
          `Unsupported Agent Plugins MCP schema version: ${mcpSchema}`,
        ),
      };
    }
    return {
      ok: false,
      result: disableMcp(
        '7.2.2',
        'mcp-config-invalid',
        `Unrecognized mcp.json $schema identifier: ${mcpSchema}`,
      ),
    };
  }

  if (!isPlainObject(parsed.mcpServers)) {
    return {
      ok: false,
      result: disableMcp(
        '7.2.2',
        'mcp-config-invalid',
        'mcp.json field "mcpServers" must be an object.',
      ),
    };
  }

  return { ok: true, mcpServers: parsed.mcpServers };
}

export function defaultPluginDataRoot(
  pluginRoot: string,
  pluginName: string,
): string {
  return resolvePath(normalizePath(dirname(pluginRoot)), `data/${pluginName}`);
}

export function loadMcpConfig(
  text: string,
  manifestSchema: string,
  pluginRoot: string,
  pluginDataRoot: string,
): LoadMcpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return disableMcp(
      '7.2.2',
      'mcp-config-invalid',
      'mcp.json is not valid JSON.',
    );
  }

  const topLevel = validateTopLevel(parsed, manifestSchema);
  if (!topLevel.ok) {
    return topLevel.result;
  }

  const mcpServersRaw = topLevel.mcpServers;
  const mcpServers: McpServerConfig[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const [name, entry] of Object.entries(mcpServersRaw)) {
    const pendingDiagnostics: Diagnostic[] = [];
    const result = parseServerEntry(
      name,
      entry,
      pluginRoot,
      pluginDataRoot,
      pendingDiagnostics,
    );

    if ('section' in result && 'rule' in result && 'origin' in result) {
      diagnostics.push(result);
      continue;
    }

    diagnostics.push(...pendingDiagnostics);
    mcpServers.push(result);
  }

  return { mcpServers, diagnostics };
}

export const MCP_CONFIG_FILE = MCP_FILE;
