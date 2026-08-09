// Reimplemented from `mastra`, packages/mcp/src/client/configuration.ts (Apache-2.0).
// Reimplemented from the described design, not copied; changes were made.

import {
  defineTool,
  type AnyTool,
  type Session,
  type ToolContext,
} from '@kuralle-agents/core';
import type { Diagnostic, McpServerConfig } from '@kuralle-agents/plugins';
import { withAuthContext } from './auth-context.js';
import { connectMcpServer } from './connect.js';
import { authFailureDiagnostic, authStatusFromError } from './headers.js';
import {
  catalogTokens,
  createDescribeTool,
  deferredInputSchema,
  resolveDisclosureMode,
  deferredToolDescription,
  MCP_DESCRIBE_TOOL,
  resolveDisclosureBudget,
} from './disclosure.js';
import { remoteMcpInputSchema } from './schema.js';
import { resolveAllowedHosts } from './ssrf.js';
import { fnv1a32, mcpToolName, rawMcpToolName } from './tool-name.js';
import type {
  ConnectedMcpServer,
  McpConnectionStore,
  McpOptions,
  McpToolsCapabilities,
  McpToolset,
  PersistedServer,
  StdioConnectorOptions,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

type StdioConnector = (
  config: Extract<McpServerConfig, { type: 'stdio' }>,
  opts: StdioConnectorOptions,
) => Promise<{ server: ConnectedMcpServer } | { diagnostic: Diagnostic }>;

let stdioConnector: StdioConnector | undefined;

/** Registered by `@kuralle-agents/mcp/node` on import — not for root consumers. */
export function registerStdioConnector(connector: StdioConnector): void {
  stdioConnector = connector;
}

function emitDiagnostic(
  opts: McpOptions | undefined,
  diagnostic: Diagnostic,
): void {
  opts?.onDiagnostic?.(diagnostic);
}

function assertToolsFilterExclusive(filter: McpOptions['tools'] | undefined): void {
  if (!filter) {
    return;
  }
  const allow = 'allow' in filter ? filter.allow : undefined;
  const block = 'block' in filter ? filter.block : undefined;
  if (allow !== undefined && block !== undefined) {
    throw new Error(
      `MCP tools filter: set either "allow" or "block", not both (got allow=${JSON.stringify(allow)} and block=${JSON.stringify(block)})`,
    );
  }
}

/**
 * `auth` and the resolver form of `allowedHosts` both receive a session, and `auth` fixes
 * a credential onto a connection that outlives the call. A toolset built from either is
 * therefore scoped to one session, and building it without one is a wiring error rather
 * than something to paper over with a placeholder.
 */
function assertSessionScopedOptions(opts: McpOptions | undefined): void {
  if (opts?.session) {
    return;
  }
  if (opts?.auth) {
    throw new Error(
      'MCP options: `auth` resolves a credential per session and is applied before the ' +
        'MCP handshake, so the toolset belongs to one session. Pass `session`, and build ' +
        'one toolset per session.',
    );
  }
  if (typeof opts?.allowedHosts === 'function') {
    throw new Error(
      'MCP options: the `allowedHosts` resolver receives the session, so it needs one. ' +
        'Pass `session`, or supply a static host list.',
    );
  }
}

/**
 * Discovery-time filter: which remote tools are projected into the agent tool map.
 * Call-time authorization is Policy.decide in the runtime executor — a filtered-out
 * tool is invisible to the model; a Policy denial is visible and refused with a reason.
 */
function toolAllowed(
  localToolName: string,
  filter: McpOptions['tools'],
): boolean {
  if (!filter) {
    return true;
  }
  if ('allow' in filter && filter.allow) {
    return filter.allow.includes(localToolName);
  }
  if ('block' in filter && filter.block) {
    return !filter.block.includes(localToolName);
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRemoteConfig(
  config: McpServerConfig,
): config is Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }> {
  return config.type === 'streamable-http' || config.type === 'sse';
}

function toPersistedServer(
  config: Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }>,
): PersistedServer {
  return {
    id: config.name,
    name: config.name,
    type: config.type,
    url: config.url,
  };
}

async function persistRemoteServer(
  store: McpConnectionStore,
  config: Extract<McpServerConfig, { type: 'streamable-http' | 'sse' }>,
): Promise<void> {
  await store.save(toPersistedServer(config));
}

/** Resolves the connect-time bearer, so `initialize` and `tools/list` are authenticated. */
async function resolveConnectHeaders(
  serverName: string,
  opts: McpOptions | undefined,
): Promise<Record<string, string>> {
  if (!opts?.auth || !opts.session) {
    return {};
  }
  const { token } = await opts.auth(serverName, { session: opts.session });
  return { Authorization: `Bearer ${token}` };
}

/**
 * The name a server's tools are projected under.
 *
 * Almost always the plugin-authored name, verbatim — that is what keeps `Policy` rules and
 * durable journal entries readable. Only when two configs in one call share a name does
 * disambiguation kick in, and then **both** are suffixed rather than the first winning.
 * Letting the first keep the bare name would make every projected name depend on the order
 * the caller happened to load plugins in, and a `Policy` rule written against `local__x`
 * would silently start matching a different server.
 *
 * The suffix hashes the server's identity — its URL, or its command line — so it is stable
 * across processes and independent of load order.
 */
function resolveProjectedNames(
  servers: readonly McpServerConfig[],
): { names: string[]; collisions: string[] } {
  const counts = new Map<string, number>();
  for (const config of servers) {
    counts.set(config.name, (counts.get(config.name) ?? 0) + 1);
  }

  const collisions = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);

  const names = servers.map((config) => {
    if ((counts.get(config.name) ?? 0) < 2) {
      return config.name;
    }
    const identity =
      config.type === 'stdio'
        ? [config.command, ...(config.args ?? [])].join(' ')
        : config.url;
    return `${config.name}_${fnv1a32(identity)}`;
  });

  return { names, collisions };
}

interface LiveServer {
  connection: ConnectedMcpServer;
  /** Set by an auth failure for the rest of the turn, and by `close()` permanently. */
  unavailable: boolean;
}

/**
 * Reconnect live MCP servers from a persisted store seed. Uses the caller-supplied
 * configs for auth, headers and fetch — only the serialisable subset was stored.
 * Per-server failure isolation applies; one dead server emits a diagnostic and does
 * not take its siblings down.
 */
export async function rebuildMcpToolsFromStorage(
  servers: readonly McpServerConfig[],
  opts: McpOptions & { storage: McpConnectionStore },
  capabilities: McpToolsCapabilities,
  connectStdio?: StdioConnector,
): Promise<McpToolset> {
  // No fallback to `servers` when the store is empty. A wake with nothing persisted
  // rebuilds nothing, and the caller uses `mcpTools` for a cold start — the two are
  // different situations and collapsing them costs the only property this function
  // has worth testing: with a fallback, a completely broken store still yields a
  // working tool map, so nothing here would ever be exercised.
  const persisted = await opts.storage.list();
  const configByName = new Map(servers.map((config) => [config.name, config]));
  const toConnect: McpServerConfig[] = [];

  for (const row of persisted) {
    const config = configByName.get(row.name);
    if (!config) {
      emitDiagnostic(opts, {
        section: '7.2.2',
        rule: 'connection-failure',
        origin: row.name,
        message: `Persisted MCP server "${row.name}" has no matching config on wake; supply the server definition again.`,
      });
      continue;
    }
    if (!isRemoteConfig(config)) {
      emitDiagnostic(opts, {
        section: '7.2.2',
        rule: 'unsupported-transport',
        origin: row.name,
        message: `Persisted MCP server "${row.name}" is remote but the supplied config is not a remote transport.`,
      });
      continue;
    }
    if (config.type !== row.type || config.url !== row.url) {
      emitDiagnostic(opts, {
        section: '7.2.2',
        rule: 'connection-failure',
        origin: row.name,
        message: `Persisted MCP server "${row.name}" does not match the supplied config (type or url differ).`,
      });
      continue;
    }
    toConnect.push(config);
  }

  return mcpToolsImpl(toConnect, opts, capabilities, connectStdio);
}

export async function mcpToolsImpl(
  servers: readonly McpServerConfig[],
  opts: McpOptions | undefined,
  capabilities: McpToolsCapabilities,
  connectStdio?: StdioConnector,
): Promise<McpToolset> {
  assertToolsFilterExclusive(opts?.tools);
  assertSessionScopedOptions(opts);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const liveByServer = new Map<string, LiveServer>();
  const closers: Array<() => Promise<void>> = [];
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    for (const live of liveByServer.values()) {
      live.unavailable = true;
    }
    // Every connection gets a close attempt; one that throws must not strand the rest.
    await Promise.all(closers.map((closeOne) => closeOne().catch(() => undefined)));
  };

  const { names: projectedNames, collisions } = resolveProjectedNames(servers);
  for (const name of collisions) {
    emitDiagnostic(opts, {
      section: '7.2.2',
      rule: 'server-name-collision',
      origin: name,
      message:
        `Two or more MCP servers in this toolset are named "${name}" — most likely from ` +
        'different plugins, since a name is only unique within one mcp.json. Their tools ' +
        'are projected under distinct suffixed names so neither is lost; rename one to ' +
        'restore the plain name.',
    });
  }

  for (const [index, config] of servers.entries()) {
    const projectedName = projectedNames[index]!;
    const allowedHosts = resolveAllowedHosts(
      config.name,
      opts?.allowedHosts,
      opts?.session,
    );

    let connectHeaders: Record<string, string>;
    try {
      connectHeaders = await resolveConnectHeaders(config.name, opts);
    } catch (error) {
      emitDiagnostic(opts, {
        section: '7.2.2',
        rule: 'connection-failure',
        origin: config.name,
        message: `Resolving credentials for MCP server "${config.name}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    const connected = await connectMcpServer(config, {
      timeoutMs,
      fetch: opts?.fetch,
      allowedHosts,
      connectHeaders,
      onDiagnostic: (d) => emitDiagnostic(opts, d),
      fs: opts?.fs,
      stdio: capabilities.stdio,
      connectStdio,
    });

    if ('diagnostic' in connected) {
      emitDiagnostic(opts, connected.diagnostic);
      continue;
    }

    if (opts?.storage && isRemoteConfig(config)) {
      await persistRemoteServer(opts.storage, config);
    }

    liveByServer.set(projectedName, {
      connection: connected.server,
      unavailable: false,
    });
    closers.push(connected.server.close);
  }

  const tools: Record<string, AnyTool> = {};
  const schemaByQualifiedName = new Map<string, Record<string, unknown>>();
  const disclosure = {
    budget: resolveDisclosureBudget(opts?.disclosure),
    alwaysLoad: opts?.disclosure?.alwaysLoad,
  };
  let anyDeferred = false;

  for (const [serverName, live] of liveByServer) {
    const projection = await projectServerTools({
      serverName,
      live,
      opts,
      disclosure,
      taken: tools,
    });
    if (projection.deferred) {
      anyDeferred = true;
    }
    for (const [qualified, tool] of Object.entries(projection.tools)) {
      tools[qualified] = tool;
    }
    for (const [qualified, schema] of projection.schemas) {
      schemaByQualifiedName.set(qualified, schema);
    }
  }

  if (anyDeferred) {
    tools[MCP_DESCRIBE_TOOL] = createDescribeTool(schemaByQualifiedName);
  }

  return { tools, close };
}

interface ServerProjection {
  tools: Record<string, AnyTool>;
  schemas: Map<string, Record<string, unknown>>;
  deferred: boolean;
}

/**
 * Project one connected server's remote tools into agent tools.
 *
 * Separated from the connect loop because the two do unrelated work on unrelated failure
 * boundaries: a connect failure drops a server, a projection failure drops a tool.
 *
 * `taken` is the tool map accumulated from earlier servers. Two servers can publish names
 * that collide only after sanitizing, so the guard has to see across servers, not just
 * within one.
 */
async function projectServerTools(args: {
  serverName: string;
  live: LiveServer;
  opts: McpOptions | undefined;
  disclosure: { budget: number; alwaysLoad: readonly string[] | undefined };
  taken: Readonly<Record<string, AnyTool>>;
}): Promise<ServerProjection> {
  const { serverName, live, opts, disclosure, taken } = args;
  const tools: Record<string, AnyTool> = {};
  const schemas = new Map<string, Record<string, unknown>>();

  let listed;
  try {
    listed = await live.connection.listTools();
  } catch (error) {
    emitDiagnostic(
      opts,
      authFailureDiagnostic(serverName, authStatusFromError(error) ?? 401),
    );
    return { tools, schemas, deferred: false };
  }

  const projected = listed.filter((remoteTool) =>
    toolAllowed(mcpToolName(serverName, remoteTool.name), opts?.tools),
  );
  const disclosureMode = resolveDisclosureMode(
    serverName,
    projected,
    disclosure.budget,
    disclosure.alwaysLoad,
  );
  const inlineSchemas = disclosureMode === 'inline';

  reportCatalogFloor(serverName, projected, disclosureMode, disclosure.budget, opts);

  for (const remoteTool of projected) {
    const qualified = mcpToolName(serverName, remoteTool.name);

    if (taken[qualified] || tools[qualified]) {
      emitDiagnostic(opts, {
        section: '7.2.2',
        rule: 'server-entry-invalid',
        origin: serverName,
        message: `MCP tool "${rawMcpToolName(serverName, remoteTool.name)}" projects to "${qualified}", which is already taken; the tool is skipped.`,
      });
      continue;
    }

    const serverDescription = remoteTool.description ?? remoteTool.name;
    const fullInputSchema =
      remoteTool.inputSchema && typeof remoteTool.inputSchema === 'object'
        ? remoteTool.inputSchema
        : { type: 'object', properties: {} };

    schemas.set(qualified, fullInputSchema);

    tools[qualified] = defineTool({
      name: qualified,
      description: inlineSchemas
        ? serverDescription
        : deferredToolDescription(serverDescription),
      input: inlineSchemas
        ? remoteMcpInputSchema(fullInputSchema)
        // `bare` drops the parameter names too. Only reached when names alone would blow
        // the budget, which is what keeps schema bulk bounded at any tool count.
        : deferredInputSchema(disclosureMode === 'names' ? fullInputSchema : undefined),
      replay: true,
      execute: (rawArgs, ctx?: ToolContext) =>
        callRemoteTool({ serverName, live, opts, qualified, remoteName: remoteTool.name }, rawArgs, ctx),
    });
  }

  return { tools, schemas, deferred: !inlineSchemas };
}

/**
 * The catalog — every tool's name and description — is what the model routes on, so no
 * disclosure tier drops it. That makes it a floor the budget cannot reach. Say so when the
 * floor is itself over budget, instead of letting an operator believe the budget bounded a
 * prompt it could not.
 */
function reportCatalogFloor(
  serverName: string,
  projected: ReadonlyArray<{ name: string; description?: string }>,
  disclosureMode: string,
  budget: number,
  opts: McpOptions | undefined,
): void {
  if (disclosureMode !== 'bare') {
    return;
  }
  const floor = catalogTokens(projected);
  if (floor <= budget) {
    return;
  }
  emitDiagnostic(opts, {
    section: '7.2.2',
    rule: 'disclosure-budget-exceeded',
    origin: serverName,
    message:
      `MCP server "${serverName}" publishes ${projected.length} tools whose names and ` +
      `descriptions alone cost about ${floor} tokens, over the ${budget}-token disclosure ` +
      'budget. Every schema is already deferred; the remaining cost is the catalog the ' +
      'model routes on. Narrow the server with the `tools` filter to go below budget.',
  });
}

async function callRemoteTool(
  binding: {
    serverName: string;
    live: LiveServer;
    opts: McpOptions | undefined;
    qualified: string;
    remoteName: string;
  },
  rawArgs: unknown,
  ctx?: ToolContext,
): Promise<unknown> {
  const { serverName, live, opts, qualified, remoteName } = binding;
  const session = ctx?.session;
  if (!session) {
    throw new Error(`MCP tool "${qualified}" requires a session context.`);
  }
  if (live.unavailable) {
    throw new Error(`MCP server "${serverName}" is unavailable.`);
  }

  // Re-resolved per call so a token rotated mid-session takes effect without a reconnect.
  // It layers over the connect-time credential, which got the handshake through.
  const generated: Record<string, string> = {};
  if (opts?.auth) {
    const { token } = await opts.auth(serverName, { session });
    generated.Authorization = `Bearer ${token}`;
  }

  const callArgs = isPlainObject(rawArgs) ? rawArgs : { value: rawArgs };

  try {
    return await withAuthContext(generated, () =>
      live.connection.callTool(remoteName, callArgs, { signal: ctx?.abortSignal }),
    );
  } catch (error) {
    const authStatus = authStatusFromError(error);
    if (authStatus === null) {
      throw error;
    }
    live.unavailable = true;
    emitDiagnostic(opts, authFailureDiagnostic(serverName, authStatus));
    throw new Error(authFailureDiagnostic(serverName, authStatus).message);
  }
}

export function mcpTools(
  servers: readonly McpServerConfig[],
  opts?: McpOptions,
): Promise<McpToolset> {
  const stdioEnabled = stdioConnector !== undefined;
  return mcpToolsImpl(
    servers,
    opts,
    { stdio: stdioEnabled },
    stdioConnector,
  );
}
