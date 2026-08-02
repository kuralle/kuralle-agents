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
