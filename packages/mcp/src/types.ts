import type { AnyTool, Session } from '@kuralle-agents/core';
import type { Diagnostic } from '@kuralle-agents/plugins';
import type { McpConnectionStore, PersistedServer } from './connection-store.js';

export type { McpConnectionStore, PersistedServer };

export interface McpOptions {
  /**
   * SSRF guard. The resolver form receives the session, so it must be scoped to one:
   * supplying it without `session` throws at wiring time.
   */
  allowedHosts?: readonly string[] | ((server: string, ctx: { session: Session }) => readonly string[]);
  /**
   * Dynamic per-session credentials.
   *
   * Resolved **before** `initialize`, so the bearer covers the handshake and
   * `tools/list`, not only `tools/call`. It is re-resolved per call so a rotated
   * token takes effect mid-session.
   *
   * Because the credential is fixed at connect time, a toolset built with `auth`
   * belongs to exactly one session, and `session` is required alongside it. Build one
   * per session and `close()` it when the session ends.
   */
  auth?: (server: string, ctx: { session: Session }) => Promise<{ token: string }>;
  /**
   * The session this toolset belongs to. Required when `auth` is set, or when
   * `allowedHosts` is a resolver — both receive it.
   */
  session?: Session;
  tools?: { allow?: readonly string[] } | { block?: readonly string[] };
  /** Per-server tool schema disclosure budget; defers full input schemas above budget. */
  disclosure?: { budget?: number | 'auto'; alwaysLoad?: readonly string[] };
  timeoutMs?: number;
  storage?: McpConnectionStore;
  onDiagnostic?: (d: Diagnostic) => void;
  /**
   * The filesystem a plugin config was loaded from. Only a stdio server needs it, to map
   * plugin-relative paths onto the host paths a subprocess is launched with.
   */
  fs?: unknown;
  /** @internal Test hook: custom fetch for all MCP HTTP transports. */
  fetch?: typeof fetch;
}

export type { Diagnostic, McpServerConfig } from '@kuralle-agents/plugins';

/**
 * A live set of projected MCP tools and the connections behind them.
 *
 * `close()` is not optional housekeeping. The connections stay open until it runs —
 * dropping the reference does not close a socket or end an SSE stream.
 */
export interface McpToolset {
  readonly tools: Record<string, AnyTool>;
  close(): Promise<void>;
}

export interface McpToolsCapabilities {
  /** When false, stdio servers are skipped with a diagnostic (workerd-clean root). */
  stdio: boolean;
}

export interface McpToolCallOptions {
  signal?: AbortSignal;
}

export interface StdioConnectorOptions {
  timeoutMs: number;
  /**
   * The filesystem the plugin was loaded from. A stdio subprocess starts from a host path,
   * but a plugin config carries paths relative to this filesystem's root, so the connector
   * needs it to translate. Absent for a hand-written config, which carries host paths.
   */
  fs?: unknown;
}

export interface ConnectedMcpServer {
  serverName: string;
  configuredHeaders: Record<string, string>;
  url?: string;
  close: () => Promise<void>;
  listTools: () => Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>
  >;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    opts?: McpToolCallOptions,
  ) => Promise<unknown>;
}

export interface ServerConnectionAttempt {
  server: ConnectedMcpServer | null;
  diagnostic: Diagnostic | null;
}
