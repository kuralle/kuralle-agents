import { Hono, type Context } from 'hono';
import {
  FLOW_DEFINITION_VERSION_STATUSES,
  FlowDefinitionConflictError,
  FlowDefinitionNotFoundError,
  FlowNameConflictError,
  flowDefinitionSchema,
  validateFlowDefinition,
  type FlowDefinition,
  type FlowDefinitionListFilter,
  type FlowDefinitionVersion,
  type FlowDefinitionVersionStatus,
  type FlowDefinitionsStore,
  type FlowValidationIssue,
  type Policy,
  type PolicyDecision,
} from '@kuralle-agents/core';

/**
 * Permission names requested through `Policy.decide({ toolName })`.
 * They are not tools — Policy is the existing decision primitive, so the HTTP
 * boundary reuses it instead of inventing a second gate.
 */
export const STORED_FLOWS_READ = 'stored-flows:read';
export const STORED_FLOWS_WRITE = 'stored-flows:write';

export interface StoredFlowsRuntime {
  addDynamicFlows(
    defs: readonly FlowDefinition[],
    opts: { agentId: string; store?: FlowDefinitionsStore; replace?: boolean },
  ): Promise<void>;
  removeDynamicFlow(name: string, opts: { agentId: string }): Promise<boolean>;
}

export interface CreateStoredFlowsRouterOptions {
  runtime: StoredFlowsRuntime;
  store: FlowDefinitionsStore;
  agentId: string;
  /**
   * Policy at the HTTP boundary. Decisions are requested as
   * `stored-flows:read` (GET) and `stored-flows:write` (POST/DELETE).
   *
   * Omitted: **default-allow**. The hono-server chat router ships authless
   * (dev/local). A missing policy matches that posture so the same process can
   * host chat and stored-flows without inventing a second auth system.
   * Production hosts must pass a Policy. `authorId` in query/body is metadata
   * for filters and Policy args — never a grant.
   *
   * `ask` has no HITL path on this surface and is treated as deny (403).
   */
  storedFlowsPolicy?: Policy;
}

export interface StoredFlowVersionBody {
  versionId: string;
  name: string;
  description: string;
  definition: FlowDefinition;
  digest: string;
  status: FlowDefinitionVersionStatus;
  authorId?: string;
  createdAt: string;
}

const parseJsonBody = async (c: Context): Promise<Record<string, unknown> | null> => {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
};

function isVersionStatus(value: string): value is FlowDefinitionVersionStatus {
  return (FLOW_DEFINITION_VERSION_STATUSES as readonly string[]).includes(value);
}

export function serializeStoredFlowVersion(row: FlowDefinitionVersion): StoredFlowVersionBody {
  return {
    versionId: row.versionId,
    name: row.name,
    description: row.description,
    definition: row.definition,
    digest: row.digest,
    status: row.status,
    ...(row.authorId !== undefined ? { authorId: row.authorId } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Absent policy → allow (dev-router default). A deny (or ask) is 403.
 * Sabotage this to always `{ kind: 'allow' }` to prove the 403 test bites.
 */
export async function decideStoredFlowsAccess(
  policy: Policy | undefined,
  permission: typeof STORED_FLOWS_READ | typeof STORED_FLOWS_WRITE,
  args: unknown,
): Promise<PolicyDecision> {
  if (!policy) return { kind: 'allow' };
  return policy.decide({ toolName: permission, args });
}

function forbidden(decision: PolicyDecision): string {
  if (decision.kind === 'deny') return decision.reason;
  return 'stored-flows request requires interactive approval, which this HTTP surface does not support';
}

async function requireAccess(
  c: Context,
  policy: Policy | undefined,
  permission: typeof STORED_FLOWS_READ | typeof STORED_FLOWS_WRITE,
  args: unknown,
): Promise<Response | null> {
  const decision = await decideStoredFlowsAccess(policy, permission, args);
  if (decision.kind === 'allow') return null;
  return c.json({ error: forbidden(decision) }, 403);
}

function parseListFilter(c: Context): { ok: true; filter: FlowDefinitionListFilter } | { ok: false; error: string } {
  const filter: FlowDefinitionListFilter = {};
  const status = c.req.query('status');
  const name = c.req.query('name');
  const authorId = c.req.query('authorId');
  if (status !== undefined && status !== '') {
    if (!isVersionStatus(status)) {
      return { ok: false, error: `status must be one of ${FLOW_DEFINITION_VERSION_STATUSES.join(', ')}` };
    }
    filter.status = status;
  }
  if (name !== undefined && name !== '') filter.name = name;
  // authorId is a list filter, not an authorization check.
  if (authorId !== undefined && authorId !== '') filter.authorId = authorId;
  return { ok: true, filter };
}

function issuesForDefinition(raw: unknown): { ok: true; def: FlowDefinition } | { ok: false; status: 400 | 422; body: unknown } {
  const parsed = flowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, body: { error: 'definition failed schema validation', details: parsed.error.issues } };
  }
  const issues = validateFlowDefinition(parsed.data);
  if (issues.length > 0) return { ok: false, status: 422, body: issues };
  return { ok: true, def: parsed.data };
}

async function versionsForName(store: FlowDefinitionsStore, name: string): Promise<FlowDefinitionVersion[]> {
  const [active, superseded, archived] = await Promise.all([
    store.list({ name, status: 'active' }),
    store.list({ name, status: 'superseded' }),
    store.list({ name, status: 'archived' }),
  ]);
  return [...active, ...superseded, ...archived];
}

function mutationStatus(error: unknown): { status: 409 | 500; body: unknown } {
  if (error instanceof FlowNameConflictError || error instanceof FlowDefinitionConflictError) {
    return { status: 409, body: { error: error.message } };
  }
  const message = error instanceof Error ? error.message : 'stored-flows mutation failed';
  return { status: 500, body: { error: message } };
}

/**
 * Stored-flow catalog routes. Mount next to `createKuralleChatRouter` —
 * `app.route('/', createStoredFlowsRouter({ runtime, store, agentId }))`.
 */
export function createStoredFlowsRouter(options: CreateStoredFlowsRouterOptions): Hono {
  const app = new Hono();
  const { runtime, store, agentId, storedFlowsPolicy } = options;

  app.get('/api/stored/flows', async (c) => {
    const parsed = parseListFilter(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const denied = await requireAccess(c, storedFlowsPolicy, STORED_FLOWS_READ, {
      method: 'GET',
      ...parsed.filter,
    });
    if (denied) return denied;
    const flows = await store.list(parsed.filter);
    return c.json({ flows: flows.map(serializeStoredFlowVersion) });
  });

  app.get('/api/stored/flows/:name', async (c) => {
    const name = c.req.param('name');
    const denied = await requireAccess(c, storedFlowsPolicy, STORED_FLOWS_READ, {
      method: 'GET',
      name,
    });
    if (denied) return denied;
    const [active, versions] = await Promise.all([
      store.getActive(name),
      versionsForName(store, name),
    ]);
    if (!active && versions.length === 0) {
      return c.json({ error: 'Flow not found' }, 404);
    }
    return c.json({
      active: active ? serializeStoredFlowVersion(active) : null,
      versions: versions.map(serializeStoredFlowVersion),
    });
  });

  app.post('/api/stored/flows', async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return c.json({ error: 'invalid body' }, 400);
    if (!('definition' in body)) return c.json({ error: 'definition required' }, 400);
    if (body.replace !== undefined && typeof body.replace !== 'boolean') {
      return c.json({ error: 'replace must be a boolean' }, 400);
    }
    if (body.authorId !== undefined && typeof body.authorId !== 'string') {
      return c.json({ error: 'authorId must be a string' }, 400);
    }
    if (body.dependencies !== undefined && !Array.isArray(body.dependencies)) {
      return c.json({ error: 'dependencies must be an array' }, 400);
    }

    const root = issuesForDefinition(body.definition);
    if (!root.ok) return c.json(root.body, root.status);
    const dependencies: FlowDefinition[] = [];
    const allIssues: FlowValidationIssue[] = [];
    for (const [index, raw] of (body.dependencies ?? []).entries()) {
      const dep = issuesForDefinition(raw);
      if (!dep.ok) {
        if (dep.status === 422 && Array.isArray(dep.body)) {
          allIssues.push(
            ...(dep.body as FlowValidationIssue[]).map((issue) => ({
              ...issue,
              path: `dependencies.${index}${issue.path ? `.${issue.path}` : ''}`,
            })),
          );
        } else {
          return c.json(dep.body, dep.status);
        }
      } else {
        dependencies.push(dep.def);
      }
    }
    if (allIssues.length > 0) return c.json(allIssues, 422);

    const replace = body.replace === true;
    const authorId = typeof body.authorId === 'string' ? body.authorId : undefined;
    const denied = await requireAccess(c, storedFlowsPolicy, STORED_FLOWS_WRITE, {
      method: 'POST',
      name: root.def.name,
      replace,
      // Metadata only — never consulted as a grant.
      ...(authorId !== undefined ? { authorId } : {}),
      dependencyNames: dependencies.map((def) => def.name),
    });
    if (denied) return denied;

    const defs = [...dependencies, root.def];
    try {
      await runtime.addDynamicFlows(defs, { agentId, store, replace });
    } catch (error) {
      const mapped = mutationStatus(error);
      return c.json(mapped.body, mapped.status);
    }

    const versions = await Promise.all(defs.map((def) => store.getActive(def.name)));
    return c.json({
      names: defs.map((def) => def.name),
      versions: versions.filter((row): row is FlowDefinitionVersion => row !== null).map(serializeStoredFlowVersion),
    });
  });

  app.delete('/api/stored/flows/:name', async (c) => {
    const name = c.req.param('name');
    const denied = await requireAccess(c, storedFlowsPolicy, STORED_FLOWS_WRITE, {
      method: 'DELETE',
      name,
    });
    if (denied) return denied;

    try {
      await store.archive(name);
    } catch (error) {
      if (!(error instanceof FlowDefinitionNotFoundError)) {
        const mapped = mutationStatus(error);
        return c.json(mapped.body, mapped.status);
      }
    }
    await runtime.removeDynamicFlow(name, { agentId });
    return c.json({ ok: true });
  });

  return app;
}
