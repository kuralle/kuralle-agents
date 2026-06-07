// `createFsTool` lives in `@kuralle-agents/core` (it needs only `defineTool` + the
// `FileSystem` interface, both core-owned), so the runtime can auto-register it with a
// static import and no core->fs dependency cycle (RFC-02 §5.2). Re-exported here for the
// `@kuralle-agents/fs` public API.
export { createFsTool } from '@kuralle-agents/core';
export type { CreateFsToolOptions, GrepHit } from '@kuralle-agents/core';
