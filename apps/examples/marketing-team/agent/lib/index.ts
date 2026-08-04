import type { AnyTool } from '@kuralle-agents/core';
import { createArtifactTools } from './artifacts/tools.js';
import { createAssetTools } from './assets/tools.js';
import { createBrandContextTools } from './brand-context/tools.js';
import { createContentTools } from './content/tools.js';
import { createLintTools } from './lint/tools.js';
import { createTrackingTools } from './tracking/tools.js';
import { createUserPreferenceTools } from './user-preferences/tools.js';
import type { Db, ResolveWorkspaceScope } from './workspace-scope.js';

export interface MarketingToolsDeps {
  db: Db;
  resolveScope: ResolveWorkspaceScope;
  /** Root directory asset bytes are written under (gitignored `storage/`). */
  storageRoot: string;
  /** The closed set of surfaces `lint_against_style` may check against. */
  surfaces: readonly [string, ...string[]];
}

/**
 * The full ported tool surface, keyed by tool name. Agent wiring (b5) picks the subset a
 * given specialist gets — e.g. the lead gets `read_artifact` but never `save_artifact` — this
 * module only builds the tools, it does not decide who is handed which.
 */
export function createMarketingTools(deps: MarketingToolsDeps): Record<string, AnyTool> {
  return {
    ...createBrandContextTools(deps),
    ...createArtifactTools(deps),
    ...createAssetTools(deps),
    ...createContentTools(deps),
    ...createLintTools(deps),
    ...createTrackingTools(deps),
    ...createUserPreferenceTools(deps),
  };
}

export * from './workspace-scope.js';
export { createArtifactTools } from './artifacts/tools.js';
export { createAssetTools } from './assets/tools.js';
export { createBrandContextTools } from './brand-context/tools.js';
export { createContentTools } from './content/tools.js';
export { createLintTools } from './lint/tools.js';
export { createTrackingTools } from './tracking/tools.js';
export { createUserPreferenceTools } from './user-preferences/tools.js';
