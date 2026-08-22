import { detectToolCatalogDrift, fingerprintToolCatalog } from '@kuralle-agents/core';
import type { Diagnostic } from '@kuralle-agents/plugins';
import type { McpOptions, PersistedTool } from './types.js';

function emitDiagnostic(
  opts: McpOptions | undefined,
  diagnostic: Diagnostic,
): void {
  opts?.onDiagnostic?.(diagnostic);
}

/**
 * Compares a fresh listing to the stored trust baseline and withholds tools that changed or
 * were added without review. Removed tools are logged and dropped from the listing naturally.
 *
 * Re-baselining is out of scope here. `save()` alone cannot do it — the stores keep the first
 * baseline recorded — so re-trusting a server is `remove(id)` then `save(row)`, which is a
 * deliberate operator action rather than something a drifting server can trigger.
 */
export async function guardListingAgainstDrift(
  serverName: string,
  tools: readonly PersistedTool[],
  baseline: Record<string, string> | undefined,
  opts: McpOptions | undefined,
): Promise<readonly PersistedTool[]> {
  if (!baseline) {
    return tools;
  }

  const current = await fingerprintToolCatalog(tools);
  const drift = detectToolCatalogDrift(current, baseline);
  const withheld = new Set([...drift.changed, ...drift.added]);

  if (withheld.size > 0) {
    emitDiagnostic(opts, {
      section: '7.2.2',
      rule: 'tool-drift',
      origin: serverName,
      message:
        `MCP server "${serverName}" published tools that differ from the trusted baseline; ` +
        `withheld: ${[...withheld].sort((a, b) => a.localeCompare(b)).join(', ')}.`,
    });
  }

  if (drift.removed.length > 0) {
    emitDiagnostic(opts, {
      section: '7.2.2',
      rule: 'tool-drift',
      origin: serverName,
      message:
        `MCP server "${serverName}" no longer publishes: ` +
        `${[...drift.removed].sort((a, b) => a.localeCompare(b)).join(', ')}.`,
    });
  }

  if (withheld.size === 0) {
    return tools;
  }
  return tools.filter((tool) => !withheld.has(tool.name));
}
