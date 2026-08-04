import type { ToolContext } from '@kuralle-agents/core';
import type { db as marketingDb } from '../../db/client.js';

// Every tool in this surface reads or writes rows scoped to exactly one workspace and one
// principal (the individual calling a preference). Neither identifier may be supplied by the
// model — a caller-supplied workspace id is the classic cross-tenant seam: unknown and
// malformed ids get rejected, but a VALID id belonging to someone else sails straight
// through. So no tool input schema below declares a workspace/tenant field; every tool
// resolves its scope from `ctx` instead, through this single seam.
//
// `resolveScope` is injected rather than read off a fixed `Session` field because core's
// `Session` type carries no tenant concept (it is channel/conversation-oriented) — this app
// has no agent wiring yet (b5), so there is no real session->tenant resolution to call. The
// resolver is where that wiring lands: an app embedding these tools behind authenticated HTTP
// resolves the caller's workspace and principal before `runtime.run()` is ever invoked, then
// supplies a resolver that reads them back off `ctx` (e.g. from `session.metadata`, or from an
// out-of-process lookup keyed on `session.id`). Nothing here trusts model input for either.
export interface WorkspaceScope {
  workspaceId: string;
  principalId: string;
}

export type ResolveWorkspaceScope = (ctx: ToolContext) => WorkspaceScope | Promise<WorkspaceScope>;

export async function resolveScope(
  resolve: ResolveWorkspaceScope,
  ctx: ToolContext | undefined,
): Promise<WorkspaceScope> {
  if (!ctx) {
    throw new Error('This tool requires a run context to resolve its workspace scope.');
  }
  return resolve(ctx);
}

/**
 * The acting agent, for the audit columns (`authored_by_agent`, `edited_by_agent`, ...).
 *
 * Reads `ctx.runState.activeAgentId`, not `ctx.session.currentAgent`: the runtime updates
 * `runState.activeAgentId` synchronously the moment a handoff fires (`Runtime.ts`'s turn loop),
 * but only writes the new value back to `session.currentAgent` once the whole turn closes. A
 * tool call made by the HANDOFF TARGET — which is every specialist's very first tool call,
 * since the lead always hands off before any specialist runs — executes while the turn is
 * still open, so `session.currentAgent` is still the SOURCE agent (the lead) at that point.
 * Verified live 2026-08-04: with `session.currentAgent` a routed `create_content` call landed
 * `authored_by_agent = 'lead'` for a piece content-marketer wrote; switching to
 * `runState.activeAgentId` (updated in place before the target's tools run) fixed it to
 * `'content-marketer'`.
 */
export function actingAgent(ctx: ToolContext | undefined): string {
  if (!ctx) {
    throw new Error('This tool requires a run context to identify the acting agent.');
  }
  return ctx.runState.activeAgentId;
}

export type Db = typeof marketingDb;
