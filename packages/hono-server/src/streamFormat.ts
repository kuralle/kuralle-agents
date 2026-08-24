import type { Context } from 'hono';

/**
 * Which wire a caller is asking for.
 *
 * Lives in its own module, beside `./streamFilter.js`, because BOTH `index.ts`
 * (chat + flow routes) and `deploymentRouter.ts` need it and `index.ts`
 * re-exports `createDeploymentRouter` — importing back the other way would be a
 * cycle. Duplicating the predicate instead would leave two copies of one rule,
 * which is the drift this wire-unification work exists to remove.
 */
export const wantsRawStreamFormat = (c: Context): boolean => c.req.query('format') === 'raw';

/**
 * Logged events rather than bare parts, in the same NDJSON encoding as `/events`.
 *
 * A turn has two consumers with different needs. A browser renders it, and the AI SDK
 * UIMessage stream is the right shape for that. A Kuralle client stores it beside the rest of
 * the session, so it needs the log's `index`, `eventId` and `at` — which no UI message format
 * has room for. The format is negotiated rather than sniffed: a client parses the wire it
 * asked for.
 */
export const wantsLoggedEventFormat = (c: Context): boolean => c.req.query('format') === 'events';
