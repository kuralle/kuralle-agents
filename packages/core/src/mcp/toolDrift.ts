import { detectToolDrift, fingerprintTools, jsonSchema, type ToolSet } from 'ai';

export type McpToolCatalogEntry = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/*
 * There is deliberately no `McpToolDriftError`. Drift is handled per tool — a changed or
 * added tool is withheld from the advertised map and reported through the existing MCP
 * diagnostic channel — so nothing throws and nothing would catch it. A thrown error would
 * take the whole server's projection down, which is the per-server response this design
 * rejects: it fails closed on a vendor's routine deploy.
 */

/**
 * Fingerprints a remote tool catalogue the way `fingerprintTools` expects: raw JSON Schema
 * objects must be wrapped with `jsonSchema()` or the digest ignores schema entirely.
 */
export async function fingerprintToolCatalog(
  tools: readonly McpToolCatalogEntry[],
): Promise<Record<string, string>> {
  const set = Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchema((tool.inputSchema ?? { type: 'object' }) as never),
      },
    ]),
  ) as unknown as ToolSet;
  return fingerprintTools(set);
}

export function detectToolCatalogDrift(
  current: Record<string, string>,
  baseline: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  return detectToolDrift(current, baseline);
}
