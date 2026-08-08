// Reimplemented from `mastra`, packages/mcp/src/client/configuration.ts (Apache-2.0).
// Reimplemented from the described design, not copied; changes were made.

/** Double-underscore join: server names may contain a single underscore. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

export function parseMcpToolName(qualified: string): { server: string; tool: string } | null {
  const idx = qualified.indexOf('__');
  if (idx <= 0 || idx === qualified.length - 2) {
    return null;
  }
  return {
    server: qualified.slice(0, idx),
    tool: qualified.slice(idx + 2),
  };
}
