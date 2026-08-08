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
  createDescribeTool,
  deferredInputSchema,
  deferredToolDescription,
  MCP_DESCRIBE_TOOL,
  resolveDisclosureBudget,
  shouldInlineServerSchemas,
} from './disclosure.js';
import { remoteMcpInputSchema } from './schema.js';
import { resolveAllowedHosts } from './ssrf.js';
import { mcpToolName } from './tool-name.js';
import type {
  ConnectedMcpServer,
  McpConnectionStore,
  McpOptions,
  McpToolsCapabilities,
  PersistedServer,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

type StdioConnector = (
  config: Extract<McpServerConfig, { type: 'stdio' }>,
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

interface LiveServer {
  connection: ConnectedMcpServer;
  disabledForTurn: boolean;
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
  connectStdio?: (
    config: Extract<McpServerConfig, { type: 'stdio' }>,
  ) => Promise<
    | { server: ConnectedMcpServer }
    | { diagnostic: Diagnostic }
  >,
): Promise<Record<string, AnyTool>> {
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
  connectStdio?: (
    config: Extract<McpServerConfig, { type: 'stdio' }>,
  ) => Promise<
    | { server: ConnectedMcpServer }
    | { diagnostic: Diagnostic }
  >,
): Promise<Record<string, AnyTool>> {
  assertToolsFilterExclusive(opts?.tools);
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sessionForConnect: Session = {
    id: 'mcp-connect',
    conversationId: 'mcp-connect',
    channelId: 'api',
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    workingMemory: {},
    currentAgent: 'mcp',
    agentStates: {},
    handoffHistory: [],
  };

  const liveByServer = new Map<string, LiveServer>();
  const closers: Array<() => Promise<void>> = [];

  for (const config of servers) {
    const allowedHosts = resolveAllowedHosts(
      config.name,
      opts?.allowedHosts,
      sessionForConnect,
    );

    const connected = await connectMcpServer(config, {
      timeoutMs,
      fetch: opts?.fetch,
      allowedHosts,
      session: sessionForConnect,
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

    liveByServer.set(config.name, {
      connection: connected.server,
      disabledForTurn: false,
    });
    closers.push(connected.server.close);
  }

  const tools: Record<string, AnyTool> = {};
  const budget = resolveDisclosureBudget(opts?.disclosure);
  const alwaysLoad = opts?.disclosure?.alwaysLoad;
  const schemaByQualifiedName = new Map<string, Record<string, unknown>>();
  let anyDeferred = false;

  for (const [serverName, live] of liveByServer) {
    let listed;
    try {
      listed = await live.connection.listTools();
    } catch (error) {
      emitDiagnostic(
        opts,
        authFailureDiagnostic(
          serverName,
          authStatusFromError(error) ?? 401,
        ),
      );
      continue;
    }

    const projected = listed.filter((remoteTool) =>
      toolAllowed(mcpToolName(serverName, remoteTool.name), opts?.tools),
    );
    const inlineSchemas = shouldInlineServerSchemas(
      serverName,
      projected,
      budget,
      alwaysLoad,
    );
    if (!inlineSchemas) {
      anyDeferred = true;
    }

    for (const remoteTool of projected) {
      const qualified = mcpToolName(serverName, remoteTool.name);
      const serverDescription = remoteTool.description ?? remoteTool.name;
      const fullInputSchema =
        remoteTool.inputSchema && typeof remoteTool.inputSchema === 'object'
          ? remoteTool.inputSchema
          : { type: 'object', properties: {} };

      schemaByQualifiedName.set(qualified, fullInputSchema);

      const description = inlineSchemas
        ? serverDescription
        : deferredToolDescription(serverDescription);
      const inputSchema = inlineSchemas
        ? remoteMcpInputSchema(fullInputSchema)
        : deferredInputSchema();

      tools[qualified] = defineTool({
        name: qualified,
        description,
        input: inputSchema,
        replay: true,
        execute: async (args, ctx?: ToolContext) => {
          const session = ctx?.session;
          if (!session) {
            throw new Error(`MCP tool "${qualified}" requires a session context.`);
          }

          const liveServer = liveByServer.get(serverName);
          if (!liveServer || liveServer.disabledForTurn) {
            throw new Error(`MCP server "${serverName}" is unavailable for this turn.`);
          }

          const generated: Record<string, string> = {};
          if (opts?.auth) {
            const { token } = await opts.auth(serverName, { session });
            generated.Authorization = `Bearer ${token}`;
          }

          const callArgs = isPlainObject(args) ? args : { value: args };

          try {
            return await withAuthContext(generated, () =>
              liveServer.connection.callTool(remoteTool.name, callArgs),
            );
          } catch (error) {
            const authStatus = authStatusFromError(error);
            if (
              authStatus ||
              (error !== null &&
                typeof error === 'object' &&
                (error as { mcpAuthFailure?: boolean }).mcpAuthFailure)
            ) {
              const status = authStatus ?? 401;
              liveServer.disabledForTurn = true;
              emitDiagnostic(opts, authFailureDiagnostic(serverName, status));
              throw new Error(authFailureDiagnostic(serverName, status).message);
            }
            throw error;
          }
        },
      });
    }
  }

  if (anyDeferred) {
    tools[MCP_DESCRIBE_TOOL] = createDescribeTool(schemaByQualifiedName);
  }

  // Connections stay open for the lifetime of the returned tool map; callers that
  // need eager teardown can drop references and rely on GC, or task 10's storage.
  void closers;

  return tools;
}

export function mcpTools(
  servers: readonly McpServerConfig[],
  opts?: McpOptions,
): Promise<Record<string, AnyTool>> {
  const stdioEnabled = stdioConnector !== undefined;
  return mcpToolsImpl(
    servers,
    opts,
    { stdio: stdioEnabled },
    stdioConnector,
  );
}
