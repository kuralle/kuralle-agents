// Reimplemented from `mastra`, packages/mcp/src/client/client.ts (Apache-2.0).
// Reimplemented from the described design, not copied; changes were made.

import type { Diagnostic } from '@kuralle-agents/plugins';
import type { Session } from '@kuralle-agents/core';
import type { McpOptions } from './types.js';

/**
 * The resolver form receives the session. `mcpToolsImpl` refuses that form without one,
 * so `session` is present wherever it is actually needed.
 */
export function resolveAllowedHosts(
  serverName: string,
  allowedHosts: McpOptions['allowedHosts'],
  session: Session | undefined,
): readonly string[] | null {
  if (allowedHosts === undefined) {
    return null;
  }
  if (typeof allowedHosts === 'function') {
    if (!session) {
      throw new Error(
        `MCP server "${serverName}": the allowedHosts resolver needs a session. Pass \`session\`.`,
      );
    }
    return allowedHosts(serverName, { session });
  }
  return allowedHosts;
}

export function hostnameAllowed(
  hostname: string,
  allowedHosts: readonly string[],
): boolean {
  const normalizedHost = hostname.toLowerCase();
  for (const allowed of allowedHosts) {
    if (allowed.toLowerCase() === normalizedHost) {
      return true;
    }
  }
  return false;
}

export function ssrfBlockedDiagnostic(serverName: string, hostname: string): Diagnostic {
  return {
    section: '7.2.2',
    rule: 'connection-failure',
    origin: serverName,
    message: `MCP server "${serverName}" host "${hostname}" is not in allowedHosts.`,
  };
}

export function parseRemoteUrl(url: string): URL | Diagnostic {
  try {
    return new URL(url);
  } catch {
    return {
      section: '7.2.2',
      rule: 'connection-failure',
      origin: url,
      message: `MCP server URL "${url}" is not a valid absolute URL.`,
    };
  }
}

export function checkAllowedHost(
  serverName: string,
  url: URL,
  allowedHosts: readonly string[] | null,
): Diagnostic | null {
  if (allowedHosts === null) {
    return null;
  }
  if (!hostnameAllowed(url.hostname, allowedHosts)) {
    return ssrfBlockedDiagnostic(serverName, url.hostname);
  }
  return null;
}
