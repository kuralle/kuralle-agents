import type { Diagnostic } from '@kuralle-agents/plugins';
import type { Session } from '@kuralle-agents/core';
import type { McpOptions } from './types.js';

export function resolveAllowedHosts(
  serverName: string,
  allowedHosts: McpOptions['allowedHosts'],
  session: Session,
): readonly string[] | null {
  if (allowedHosts === undefined) {
    return null;
  }
  if (typeof allowedHosts === 'function') {
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
