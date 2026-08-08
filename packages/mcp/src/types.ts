import type { Session } from '@kuralle-agents/core';
import type { Diagnostic } from '@kuralle-agents/plugins';

/** Reserved for task 10 (Durable Object hibernation persistence). */
export interface McpConnectionStore {
  // Implemented by @kuralle-agents/mcp task 10.
}

export interface McpOptions {
  allowedHosts?: readonly string[] | ((server: string, ctx: { session: Session }) => readonly string[]);
  auth?: (server: string, ctx: { session: Session }) => Promise<{ token: string }>;
  tools?: { allow?: readonly string[] } | { block?: readonly string[] };
  /** Per-server tool schema disclosure budget; defers full input schemas above budget. */
  disclosure?: { budget?: number | 'auto'; alwaysLoad?: readonly string[] };
  timeoutMs?: number;
  /** Implemented by task 10 (connection hibernation). */
  storage?: McpConnectionStore;
  onDiagnostic?: (d: Diagnostic) => void;
  /** @internal Test hook: custom fetch for all MCP HTTP transports. */
  fetch?: typeof fetch;
}

export type { Diagnostic, McpServerConfig } from '@kuralle-agents/plugins';

export interface McpToolsCapabilities {
  /** When false, stdio servers are skipped with a diagnostic (workerd-clean root). */
  stdio: boolean;
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
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface ServerConnectionAttempt {
  server: ConnectedMcpServer | null;
  diagnostic: Diagnostic | null;
}
