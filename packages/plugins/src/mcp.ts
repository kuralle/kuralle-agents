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

/**
 * The one result convention in this file. Every validator either yields the value it
 * derived or the diagnostic explaining why it could not — never a bare union the caller
 * has to identify by sniffing for a `section` property, and never a value stripped of the
 * reason it was rejected.
 */
type Parsed<T> = { ok: true; value: T } | { ok: false; diagnostic: Diagnostic };

type Failure = { ok: false; diagnostic: Diagnostic };

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail(section: string, rule: string, message: string): Failure {
  return { ok: false, diagnostic: diagnostic(section, rule, message) };
}

/** §7.2.2's catch-all for a malformed server entry — the most common rejection here. */
function invalidEntry(message: string): Failure {
  return fail('7.2.2', 'server-entry-invalid', message);
}

/** §7.2.2's catch-all for a malformed `mcp.json` as a whole, which disables MCP. */
function invalidConfig(message: string): Failure {
  return fail('7.2.2', 'mcp-config-invalid', message);
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

/**
 * Returns the command as it should be launched: a bare token untouched for platform
 * search (§7.2.1), or a plugin-relative path resolved against the plugin root. The
 * resolved value used to be computed here and thrown away, which is why a bundled
 * `./bin/server` never started.
 */
function validateCommand(command: string, pluginRoot: string): Parsed<string> {
  if (command.length === 0) {
    return invalidEntry('stdio server "command" must be a non-empty string.');
  }

  const hasPathSeparator = command.includes('/') || command.includes('\\');

  if (!hasPathSeparator) {
    return ok(command);
  }

  if (!command.startsWith('./')) {
    return fail(
      '4.1',
      'path-escapes-plugin-root',
      `stdio server command "${command}" is not a bare executable or plugin-relative path.`,
    );
  }

  const resolved = resolvePath(pluginRoot, command.slice(2));
  if (!containsPath(pluginRoot, resolved)) {
    return fail(
      '4.1',
      'path-escapes-plugin-root',
      `stdio server command "${command}" resolves outside the plugin root.`,
    );
  }

  return ok(resolved);
}

function validateCwd(
  cwd: unknown,
  pluginRoot: string,
  pluginDataRoot: string,
): Parsed<string> {
  if (cwd === undefined) {
    // §7.2.1: when omitted, the working directory is the plugin root.
    return ok(normalizePath(pluginRoot));
  }

  if (typeof cwd !== 'string' || cwd.length === 0) {
    return invalidEntry('stdio server "cwd" must be a non-empty string.');
  }

  if (!CWD_PATTERN.test(cwd)) {
    return invalidEntry(
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
    return fail(
      '7.2.1',
      'path-escapes-plugin-root',
      `stdio server "cwd" value "${cwd}" resolves outside its permitted root.`,
    );
  }

  return ok(resolved);
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

/** Returns the reason the URL is unusable, or null when it satisfies §7.2.1. */
function validateRemoteUrl(url: string): Failure | null {
  const reject = (reason: string): Failure =>
    fail(
      '7.2.1',
      'server-entry-invalid',
      `Remote MCP server URL "${url}" ${reason}`,
    );

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return reject('is not a valid absolute URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return reject('must use http or https.');
  }

  if (parsed.username || parsed.password) {
    return reject('must not contain user information.');
  }

  if (parsed.hash.length > 0) {
    return reject('must not contain a fragment.');
  }

  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return reject('must use https for non-loopback hosts.');
  }

  return null;
}

function looksLikeSecret(key: string, value: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) {
    return true;
  }
  return SECRET_VALUE_PREFIX_PATTERN.test(value);
}

/**
 * An entry's `env`, expanded, plus the advisory diagnostics it earned. Warnings ride with
 * the value because they are only reported when the entry survives — a rejected entry's
 * `secret-in-env` note describes something that is not being launched.
 */
interface ValidatedEnv {
  env: Record<string, string> | undefined;
  warnings: Diagnostic[];
}

function validateEnv(
  name: string,
  env: unknown,
  pluginRoot: string,
  pluginDataRoot: string,
): Parsed<ValidatedEnv> {
  if (env === undefined) {
    return ok({ env: undefined, warnings: [] });
  }

  if (!isPlainObject(env)) {
    return invalidEntry(
      `stdio MCP server "${name}" has an invalid "env" field.`,
    );
  }

  // §9.2: the client always supplies these, and a plugin may never set them. Checked
  // across every key before anything else, so a reserved name is reported as one whatever
  // else is wrong with the object — the rule is normative, the shape complaint is not.
  if ('PLUGIN_ROOT' in env || 'PLUGIN_DATA' in env) {
    return fail(
      '9.2',
      'env-reserved-name',
      `stdio MCP server "${name}" uses a reserved environment variable name.`,
    );
  }

  const result: Record<string, string> = {};
  const warnings: Diagnostic[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      return invalidEntry(
        `stdio MCP server "${name}" has an invalid "env" field.`,
      );
    }
    if (looksLikeSecret(key, value)) {
      warnings.push(
        diagnostic(
          '9.2',
          'secret-in-env',
          `Environment value for "${key}" appears to contain a credential.`,
        ),
      );
    }
    result[key] = expandPluginPlaceholders(value, pluginRoot, pluginDataRoot);
  }

  return ok({ env: result, warnings });
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

/**
 * A server entry that survived parsing, with any advisory diagnostics it earned. Warnings
 * are carried rather than pushed into an out-param so that rejecting the entry discards
 * them by construction instead of by the caller remembering to.
 */
interface ParsedServer {
  config: McpServerConfig;
  warnings: Diagnostic[];
}

function parseStdioServer(
  name: string,
  entry: Record<string, unknown>,
  pluginRoot: string,
  pluginDataRoot: string,
): Parsed<ParsedServer> {
  if (hasUnknownFields(entry, STDIO_FIELDS)) {
    return invalidEntry(
      `MCP server "${name}" contains unknown or cross-variant fields.`,
    );
  }

  if (typeof entry.command !== 'string') {
    return invalidEntry(
      `stdio MCP server "${name}" is missing a valid "command" field.`,
    );
  }

  const command = validateCommand(entry.command, pluginRoot);
  if (!command.ok) {
    return command;
  }

  const cwd = validateCwd(entry.cwd, pluginRoot, pluginDataRoot);
  if (!cwd.ok) {
    return cwd;
  }

  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args)) {
      return invalidEntry(
        `stdio MCP server "${name}" has an invalid "args" field.`,
      );
    }
    for (const arg of entry.args) {
      if (typeof arg !== 'string') {
        return invalidEntry(
          `stdio MCP server "${name}" has a non-string "args" entry.`,
        );
      }
    }
  }

  const env = validateEnv(name, entry.env, pluginRoot, pluginDataRoot);
  if (!env.ok) {
    return env;
  }

  const config: McpServerConfig = {
    name,
    type: 'stdio',
    command: command.value,
    cwd: cwd.value,
    pluginRoot: normalizePath(pluginRoot),
    pluginDataRoot: normalizePath(pluginDataRoot),
  };

  if (entry.args !== undefined) {
    config.args = (entry.args as string[]).map((arg) =>
      expandPluginPlaceholders(arg, pluginRoot, pluginDataRoot),
    );
  }

  if (env.value.env !== undefined) {
    config.env = env.value.env;
  }

  return ok({ config, warnings: env.value.warnings });
}

function parseRemoteServer(
  name: string,
  entry: Record<string, unknown>,
  transport: 'streamable-http' | 'sse',
): Parsed<ParsedServer> {
  if (hasUnknownFields(entry, REMOTE_FIELDS)) {
    return invalidEntry(
      `MCP server "${name}" contains unknown or cross-variant fields.`,
    );
  }

  if (typeof entry.url !== 'string' || entry.url.length === 0) {
    return invalidEntry(
      `${transport} MCP server "${name}" is missing a valid "url" field.`,
    );
  }

  const urlFailure = validateRemoteUrl(entry.url);
  if (urlFailure) {
    return urlFailure;
  }

  const config: Extract<McpServerConfig, { url: string }> = {
    name,
    type: transport,
    url: entry.url,
  };

  if (entry.headers !== undefined) {
    if (!isPlainObject(entry.headers)) {
      return invalidEntry(
        `${transport} MCP server "${name}" has an invalid "headers" field.`,
      );
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.headers)) {
      if (typeof value !== 'string') {
        return invalidEntry(
          `${transport} MCP server "${name}" has a non-string header value.`,
        );
      }
      headers[key] = value;
    }

    if (hasDuplicateHeaderNames(headers)) {
      return invalidEntry(
        `${transport} MCP server "${name}" repeats a header name under different casing.`,
      );
    }

    config.headers = headers;
  }

  return ok({ config, warnings: [] });
}

function parseServerEntry(
  name: string,
  entry: unknown,
  pluginRoot: string,
  pluginDataRoot: string,
): Parsed<ParsedServer> {
  if (!isPlainObject(entry)) {
    return invalidEntry(`MCP server "${name}" must be an object.`);
  }

  const type = entry.type;
  if (type === 'stdio') {
    return parseStdioServer(name, entry, pluginRoot, pluginDataRoot);
  }

  if (type === 'streamable-http' || type === 'sse') {
    return parseRemoteServer(name, entry, type);
  }

  return invalidEntry(
    `MCP server "${name}" declares an unsupported transport type.`,
  );
}

/** §7.2.2 rule 2: a bad `mcp.json` disables MCP for the plugin, and nothing else. */
function mcpDisabled(reason: Diagnostic): LoadMcpResult {
  return { mcpServers: [], diagnostics: [reason] };
}

function validateTopLevel(
  parsed: unknown,
  manifestSchema: string,
): Parsed<Record<string, unknown>> {
  if (!isPlainObject(parsed)) {
    return invalidConfig('mcp.json must contain a top-level object.');
  }

  const permitted = new Set(['$schema', 'mcpServers']);
  for (const key of Object.keys(parsed)) {
    if (!permitted.has(key)) {
      return invalidConfig(
        `mcp.json contains unknown top-level field "${key}".`,
      );
    }
  }

  if (typeof parsed.$schema !== 'string' || parsed.$schema.length === 0) {
    return invalidConfig('mcp.json is missing required field "$schema".');
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
    return fail(
      '10.1',
      'mcp-config-version-mismatch',
      'mcp.json $schema version does not match plugin.json.',
    );
  }

  if (mcpSchema !== SUPPORTED_MCP_SCHEMA) {
    return invalidConfig(
      AGENT_PLUGINS_MCP_SCHEMA_PATTERN.test(mcpSchema)
        ? `Unsupported Agent Plugins MCP schema version: ${mcpSchema}`
        : `Unrecognized mcp.json $schema identifier: ${mcpSchema}`,
    );
  }

  if (!isPlainObject(parsed.mcpServers)) {
    return invalidConfig('mcp.json field "mcpServers" must be an object.');
  }

  return ok(parsed.mcpServers);
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
    return mcpDisabled(
      diagnostic('7.2.2', 'mcp-config-invalid', 'mcp.json is not valid JSON.'),
    );
  }

  const topLevel = validateTopLevel(parsed, manifestSchema);
  if (!topLevel.ok) {
    return mcpDisabled(topLevel.diagnostic);
  }

  const mcpServers: McpServerConfig[] = [];
  const diagnostics: Diagnostic[] = [];

  // §7.2.2: each entry loads or fails on its own; one bad entry never sinks the rest.
  for (const [name, entry] of Object.entries(topLevel.value)) {
    const result = parseServerEntry(name, entry, pluginRoot, pluginDataRoot);

    if (!result.ok) {
      diagnostics.push(result.diagnostic);
      continue;
    }

    diagnostics.push(...result.value.warnings);
    mcpServers.push(result.value.config);
  }

  return { mcpServers, diagnostics };
}

export const MCP_CONFIG_FILE = MCP_FILE;
