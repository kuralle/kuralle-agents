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

export const STORED_FLOWS_READ = 'stored-flows:read';
export const STORED_FLOWS_WRITE = 'stored-flows:write';

export interface StoredFlowsRuntime {
  addDynamicFlows(
    defs: readonly FlowDefinition[],
    opts: { agentId: string; store?: FlowDefinitionsStore; replace?: boolean },
  ): Promise<void>;
  removeDynamicFlow(name: string, opts: { agentId: string }): Promise<boolean>;
}

export interface StoredFlowsHttpOptions {
  request: Request;
  store: FlowDefinitionsStore;
  /**
   * Built only for POST/DELETE. GET reads the store and must not mutate
   * the live catalog or the thread pin-key cache.
   */
  runtimeForWrite: () => Promise<{ runtime: StoredFlowsRuntime; agentId: string }>;
  storedFlowsPolicy?: Policy;
  onMutated?: () => void;
}

type PathMatch =
  | { kind: 'collection' }
  | { kind: 'item'; name: string };

function matchPath(pathname: string): PathMatch | null {
  const collection = pathname.match(/\/api\/stored\/flows\/?$/);
  if (collection) return { kind: 'collection' };
  const item = pathname.match(/\/api\/stored\/flows\/([^/]+)\/?$/);
  if (!item?.[1]) return null;
  return { kind: 'item', name: decodeURIComponent(item[1]) };
}

function isVersionStatus(value: string): value is FlowDefinitionVersionStatus {
  return (FLOW_DEFINITION_VERSION_STATUSES as readonly string[]).includes(value);
}

function serialize(row: FlowDefinitionVersion) {
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

async function decide(
  policy: Policy | undefined,
  permission: typeof STORED_FLOWS_READ | typeof STORED_FLOWS_WRITE,
  args: unknown,
): Promise<PolicyDecision> {
  if (!policy) return { kind: 'allow' };
  return policy.decide({ toolName: permission, args });
}

function forbidden(decision: PolicyDecision): Response {
  const error =
    decision.kind === 'deny'
      ? decision.reason
      : 'stored-flows request requires interactive approval, which this HTTP surface does not support';
  return Response.json({ error }, { status: 403 });
}

function issuesForDefinition(
  raw: unknown,
): { ok: true; def: FlowDefinition } | { ok: false; status: 400 | 422; body: unknown } {
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

function mutationError(error: unknown): Response {
  if (error instanceof FlowNameConflictError || error instanceof FlowDefinitionConflictError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  const message = error instanceof Error ? error.message : 'stored-flows mutation failed';
  return Response.json({ error: message }, { status: 500 });
}

function parseListFilter(url: URL): { ok: true; filter: FlowDefinitionListFilter } | { ok: false; error: string } {
  const filter: FlowDefinitionListFilter = {};
  const status = url.searchParams.get('status');
  const name = url.searchParams.get('name');
  const authorId = url.searchParams.get('authorId');
  if (status) {
    if (!isVersionStatus(status)) {
      return { ok: false, error: `status must be one of ${FLOW_DEFINITION_VERSION_STATUSES.join(', ')}` };
    }
    filter.status = status;
  }
  if (name) filter.name = name;
  if (authorId) filter.authorId = authorId;
  return { ok: true, filter };
}

/**
 * Same stored-flows HTTP surface as hono-server. Returns null when the
 * request is not a stored-flows route.
 *
 * Absent policy default-allows — same authless-dev posture as the hono
 * router. Production DOs override `getStoredFlowsPolicy`.
 */
export async function dispatchStoredFlowsRequest(options: StoredFlowsHttpOptions): Promise<Response | null> {
  const url = new URL(options.request.url);
  const path = matchPath(url.pathname);
  if (!path) return null;

  const method = options.request.method;
  const policy = options.storedFlowsPolicy;

  if (method === 'GET' && path.kind === 'collection') {
    const parsed = parseListFilter(url);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const decision = await decide(policy, STORED_FLOWS_READ, { method: 'GET', ...parsed.filter });
    if (decision.kind !== 'allow') return forbidden(decision);
    const flows = await options.store.list(parsed.filter);
    return Response.json({ flows: flows.map(serialize) });
  }

  if (method === 'GET' && path.kind === 'item') {
    const decision = await decide(policy, STORED_FLOWS_READ, { method: 'GET', name: path.name });
    if (decision.kind !== 'allow') return forbidden(decision);
    const [active, versions] = await Promise.all([
      options.store.getActive(path.name),
      versionsForName(options.store, path.name),
    ]);
    if (!active && versions.length === 0) {
      return Response.json({ error: 'Flow not found' }, { status: 404 });
    }
    return Response.json({
      active: active ? serialize(active) : null,
      versions: versions.map(serialize),
    });
  }

  if (method === 'POST' && path.kind === 'collection') {
    const body = (await options.request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json({ error: 'invalid body' }, { status: 400 });
    }
    if (!('definition' in body)) return Response.json({ error: 'definition required' }, { status: 400 });
    if (body.replace !== undefined && typeof body.replace !== 'boolean') {
      return Response.json({ error: 'replace must be a boolean' }, { status: 400 });
    }
    if (body.authorId !== undefined && typeof body.authorId !== 'string') {
      return Response.json({ error: 'authorId must be a string' }, { status: 400 });
    }
    if (body.dependencies !== undefined && !Array.isArray(body.dependencies)) {
      return Response.json({ error: 'dependencies must be an array' }, { status: 400 });
    }

    const root = issuesForDefinition(body.definition);
    if (!root.ok) return Response.json(root.body, { status: root.status });
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
          return Response.json(dep.body, { status: dep.status });
        }
      } else {
        dependencies.push(dep.def);
      }
    }
    if (allIssues.length > 0) return Response.json(allIssues, { status: 422 });

    const replace = body.replace === true;
    const authorId = typeof body.authorId === 'string' ? body.authorId : undefined;
    const decision = await decide(policy, STORED_FLOWS_WRITE, {
      method: 'POST',
      name: root.def.name,
      replace,
      ...(authorId !== undefined ? { authorId } : {}),
      dependencyNames: dependencies.map((def) => def.name),
    });
    if (decision.kind !== 'allow') return forbidden(decision);

    const defs = [...dependencies, root.def];
    try {
      const { runtime, agentId } = await options.runtimeForWrite();
      await runtime.addDynamicFlows(defs, { agentId, store: options.store, replace });
    } catch (error) {
      return mutationError(error);
    }
    options.onMutated?.();
    const versions = await Promise.all(defs.map((def) => options.store.getActive(def.name)));
    return Response.json({
      names: defs.map((def) => def.name),
      versions: versions.filter((row): row is FlowDefinitionVersion => row !== null).map(serialize),
    });
  }

  if (method === 'DELETE' && path.kind === 'item') {
    const decision = await decide(policy, STORED_FLOWS_WRITE, { method: 'DELETE', name: path.name });
    if (decision.kind !== 'allow') return forbidden(decision);
    try {
      await options.store.archive(path.name);
    } catch (error) {
      if (!(error instanceof FlowDefinitionNotFoundError)) return mutationError(error);
    }
    try {
      const { runtime, agentId } = await options.runtimeForWrite();
      await runtime.removeDynamicFlow(path.name, { agentId });
    } catch (error) {
      return mutationError(error);
    }
    options.onMutated?.();
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'method not allowed' }, { status: 405 });
}
