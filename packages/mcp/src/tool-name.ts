// Reimplemented from `mastra`, packages/mcp/src/client/configuration.ts (Apache-2.0).
// Reimplemented from the described design, not copied; changes were made.

/**
 * Model providers accept tool names matching `^[a-zA-Z0-9_-]{1,64}$` and reject the
 * request outright otherwise. MCP places no such limit on what a server may publish, so
 * a name arriving over the wire is untrusted input for this constraint as much as any
 * other: `search.docs`, a 90-character name, or a unicode one are all legal MCP and all
 * fatal to the turn.
 */
const MAX_TOOL_NAME_LENGTH = 64;
const ILLEGAL_CHARACTERS = /[^a-zA-Z0-9_-]/g;

/** Double-underscore join: server names may contain a single underscore. */
export function rawMcpToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

/**
 * FNV-1a, 32-bit. Deterministic, synchronous and dependency-free — the root export has
 * to stay workerd-clean, and the name has to be stable across processes because `Policy`
 * rules and durable journal entries are written against it.
 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The provider-legal projected name for a remote tool.
 *
 * The common case is untouched: `server__tool` passes through verbatim, so names stay
 * readable in transcripts and `Policy` rules keep matching. Only a name that would be
 * rejected is rewritten, and then a hash of the original is appended so two different
 * remote tools cannot land on one projected name.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const raw = rawMcpToolName(serverName, toolName);
  const sanitized = raw.replace(ILLEGAL_CHARACTERS, '_');

  if (sanitized === raw && raw.length <= MAX_TOOL_NAME_LENGTH) {
    return raw;
  }

  const suffix = `_${fnv1a32(raw)}`;
  const head = sanitized.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length);
  return `${head}${suffix}`;
}

export function isProviderLegalToolName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}
