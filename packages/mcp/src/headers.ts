import type { Diagnostic } from '@kuralle-agents/plugins';

/**
 * Client-generated headers take precedence over plugin-configured headers when names
 * match case-insensitively (Agent Plugins §7.2.1).
 */
export function mergeRequestHeaders(
  configured: Record<string, string> | undefined,
  generated: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const generatedLower = new Set(
    Object.keys(generated).map((name) => name.toLowerCase()),
  );

  if (configured) {
    for (const [name, value] of Object.entries(configured)) {
      if (!generatedLower.has(name.toLowerCase())) {
        merged[name] = value;
      }
    }
  }

  for (const [name, value] of Object.entries(generated)) {
    merged[name] = value;
  }

  return merged;
}

export function headersToFetchInit(headers: Record<string, string>): Headers {
  return new Headers(headers);
}

export function isAuthFailure(error: unknown): boolean {
  return authStatusFromError(error) !== null;
}

export function authFailureDiagnostic(serverName: string, status: 401 | 403): Diagnostic {
  return {
    section: '7.2.2',
    rule: 'connection-failure',
    origin: serverName,
    message:
      status === 401
        ? `MCP server "${serverName}" rejected authorization (HTTP 401).`
        : `MCP server "${serverName}" denied access (HTTP 403).`,
  };
}

export function authStatusFromError(error: unknown): 401 | 403 | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  if (status === 401) {
    return 401;
  }
  if (status === 403) {
    return 403;
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'CLIENT_HTTP_AUTHENTICATION') {
    return 401;
  }
  if (code === 'CLIENT_HTTP_FORBIDDEN') {
    return 403;
  }
  return null;
}
