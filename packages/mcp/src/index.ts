// NOTE: stdio MCP transport lives at `@kuralle-agents/mcp/node`, NOT the root — it pulls
// `cross-spawn` via `@modelcontextprotocol/client/stdio`, which is not workerd-clean.
// Keeping stdio off the root export preserves the root package's Cloudflare Workers portability.
//
// The root is workerd-clean *given `nodejs_compat`*, not unconditionally: `auth-context.ts`
// imports `AsyncLocalStorage` from `node:async_hooks`, which workerd provides only under that
// flag. Every wrangler config in this repo already sets it, so this matches the existing
// platform baseline rather than adding a requirement — but it is a real edge, so it is stated
// here rather than left for a deployment to discover.

export { mcpTools } from './mcp-tools.js';
export { composeMcpSystemPrompt } from './compose-prompt.js';
export {
  estimateTokens,
  DEFAULT_DISCLOSURE_BUDGET_TOKENS,
  MCP_DESCRIBE_TOOL,
} from './disclosure.js';
export type {
  McpOptions,
  McpConnectionStore,
  Diagnostic,
  McpServerConfig,
} from './types.js';
