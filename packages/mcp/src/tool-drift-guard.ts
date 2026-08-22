import { detectToolCatalogDrift, fingerprintToolCatalog } from '@kuralle-agents/core';
import type { Diagnostic } from '@kuralle-agents/plugins';
import type { McpConnectionStore, McpOptions, PersistedTool } from './types.js';

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
export interface GuardedListing {
  /** Tools safe to project as themselves. */
  trusted: readonly PersistedTool[];
  /**
   * Tools whose pinned definition moved. Projected under their own name but with our
   * description and no schema — see `quarantineTool` — so the model learns the capability is
   * unavailable instead of watching it vanish.
   */
  quarantined: readonly string[];
}

export async function guardListingAgainstDrift(
  serverName: string,
  tools: readonly PersistedTool[],
  baseline: Record<string, string> | undefined,
  opts: McpOptions | undefined,
): Promise<GuardedListing> {
  if (!baseline) {
    return { trusted: tools, quarantined: [] };
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

  // Split by drift kind. A *changed* tool was already trusted, so its disappearance needs
  // explaining — it is quarantined. An *added* tool was never trusted and the model has never
  // seen it, so there is nothing to explain and advertising it would spend prompt budget on a
  // capability nobody approved. That split also bounds the cost: quarantine entries can never
  // outnumber the tools already in the baseline.
  const changed = new Set(drift.changed);
  const added = new Set(drift.added);
  return {
    trusted: tools.filter((tool) => !changed.has(tool.name) && !added.has(tool.name)),
    quarantined: tools.filter((tool) => changed.has(tool.name)).map((tool) => tool.name),
  };
}

/**
 * Clear a server's recorded trust baseline so the next connect re-establishes it from whatever
 * the server currently publishes.
 *
 * This is the sanctioned way back from a drift. `save()` deliberately cannot replace a baseline —
 * both stores drop an incoming one when they already hold it, which is what stops a compromised
 * catalogue from becoming the trusted one by being written again. Re-trusting therefore has to be
 * a distinct, deliberate operator action rather than a side effect of an ordinary write.
 *
 * Returns whether a stored row was found. Re-trusting an unknown server changes nothing.
 */
export async function retrustMcpServer(
  store: McpConnectionStore,
  serverName: string,
): Promise<boolean> {
  const row = (await store.list()).find((entry) => entry.id === serverName);
  if (!row) {
    return false;
  }
  await store.remove(row.id);
  const { toolFingerprints: _dropped, ...withoutBaseline } = row;
  await store.save(withoutBaseline);
  return true;
}
