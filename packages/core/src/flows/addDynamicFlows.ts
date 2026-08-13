import type { AgentConfig } from '../types/agentConfig.js';
import type { AnyTool } from '../types/effectTool.js';
import type { Flow } from '../types/flow.js';
import type { LanguageModel } from 'ai';
import { compileAuthoringPredicates } from './authoring/compileAuthoringPredicates.js';
import type { NlPredicateProvider } from './authoring/compileNlPredicate.js';
import type { AuthoringFlowDefinition } from './definition/authoring.js';
import { rehydrateFlow } from './definition/rehydrate.js';
import { assertValidFlowDefinition, validateFlowDefinition } from './definition/validate/index.js';
import { formatFlowValidationIssues } from './definition/validate/format.js';
import { walkFlowDefinition } from './definition/validate/walk.js';
import type { FlowRegistryIndex, FlowRegistrySchemas } from './definition/validate/types.js';
import type { FlowDefinition } from './definition/types.js';
import type { FlowDefinitionVersion, FlowDefinitionsStore } from './definition/store.js';
import { FlowCycleError, FlowNameConflictError, LiveFlowCatalog } from './liveFlowCatalog.js';

export interface AgentFlowToolSurface {
  lookup: (id: string) => AnyTool | undefined;
  index: NonNullable<FlowRegistryIndex['tools']>;
}

export function agentToolSurface(
  agent: AgentConfig,
  configTools?: Record<string, AnyTool>,
): AgentFlowToolSurface {
  const surface: Record<string, AnyTool> = {
    ...(configTools ?? {}),
    ...(agent.tools ?? {}),
    ...(agent.globalTools ?? {}),
  };
  const index: NonNullable<FlowRegistryIndex['tools']> = {};
  for (const [id, tool] of Object.entries(surface)) {
    index[id] = { id: tool.name ?? id };
    if (tool.name && tool.name !== id) {
      index[tool.name] = { id: tool.name };
    }
  }
  return {
    lookup: (id) => surface[id] ?? Object.values(surface).find((tool) => tool.name === id),
    index,
  };
}

export function nestedFlowReferences(def: FlowDefinition): string[] {
  return walkFlowDefinition(def).choiceFlows.map((visit) => visit.flowId);
}

export function topoSortFlowDefinitions(defs: readonly FlowDefinition[]): FlowDefinition[] {
  const names = new Set(defs.map((def) => def.name));
  const byName = new Map(defs.map((def) => [def.name, def]));
  const indegree = new Map(defs.map((def) => [def.name, 0]));
  const edges = new Map(defs.map((def) => [def.name, [] as string[]]));

  for (const def of defs) {
    const seen = new Set<string>();
    for (const dep of nestedFlowReferences(def)) {
      if (!names.has(dep) || seen.has(dep) || dep === def.name) continue;
      seen.add(dep);
      edges.get(dep)!.push(def.name);
      indegree.set(def.name, (indegree.get(def.name) ?? 0) + 1);
    }
  }

  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  const ordered: FlowDefinition[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    ordered.push(byName.get(name)!);
    const next = [...(edges.get(name) ?? [])].sort((a, b) => a.localeCompare(b));
    for (const target of next) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
        queue.sort((a, b) => a.localeCompare(b));
      }
    }
  }

  if (ordered.length !== defs.length) {
    throw new FlowCycleError();
  }
  return ordered;
}

function assertUniqueBundleNames(
  defs: readonly FlowDefinition[],
  catalog: LiveFlowCatalog,
  replace: boolean,
): void {
  const seen = new Set<string>();
  for (const def of defs) {
    if (seen.has(def.name)) {
      throw new FlowNameConflictError(def.name, 'bundle');
    }
    seen.add(def.name);
    if (catalog.hasCodeFlow(def.name)) {
      throw new FlowNameConflictError(def.name, 'code');
    }
    if (!replace && catalog.getDynamic(def.name)) {
      throw new FlowNameConflictError(def.name, 'dynamic');
    }
  }
}

function registryIndex(
  catalog: LiveFlowCatalog,
  bundle: readonly FlowDefinition[],
  toolIndex: NonNullable<FlowRegistryIndex['tools']>,
): FlowRegistryIndex {
  const flows: Record<string, FlowRegistrySchemas> = {};
  for (const flow of catalog.list()) {
    flows[flow.name] = { id: flow.name };
  }
  for (const def of bundle) {
    flows[def.name] = {
      id: def.name,
      ...(def.inputSchema ? { inputSchema: def.inputSchema } : {}),
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    };
  }
  return { tools: toolIndex, flows };
}

export interface RegisterDynamicFlowBundleOptions {
  defs: readonly AuthoringFlowDefinition[];
  catalog: LiveFlowCatalog;
  tools: (id: string) => AnyTool | undefined;
  toolIndex: NonNullable<FlowRegistryIndex['tools']>;
  store?: FlowDefinitionsStore;
  replace?: boolean;
  compiler?: NlPredicateProvider | LanguageModel;
}

/**
 * Atomically register a bundle of flow definitions on a live catalog.
 *
 * Persistence is not transactional across rows. On failure the in-memory
 * catalog rolls back this bundle's registrations (unregister added names;
 * restore replaced ones). Members that already persisted are compensated so
 * a later `loadDynamicFlows` matches that rollback: added names are archived;
 * replaced names restore the prior active version (or archive when there was
 * none). A secondary compensation failure is logged and does not mask the
 * original error.
 */
export async function registerDynamicFlowBundle(
  options: RegisterDynamicFlowBundleOptions,
): Promise<Flow[]> {
  const compiled: FlowDefinition[] = [];
  const provenances = new Map<string, { modelId: string; promptHash: string; compilerVersion: string }>();
  const compileFailures: string[] = [];
  for (const def of options.defs) {
    const result = await compileAuthoringPredicates(structuredClone(def), options.compiler);
    if (result.issues.length > 0) {
      compileFailures.push(
        `Flow definition "${def.name}" failed validation with ${result.issues.length} issue(s):\n${formatFlowValidationIssues(result.issues)}`,
      );
      continue;
    }
    compiled.push(result.definition);
    if (result.provenance) {
      provenances.set(def.name, result.provenance);
    }
  }
  if (compileFailures.length > 0) {
    throw new Error(compileFailures.join('\n'));
  }
  const cloned = compiled;
  const replace = options.replace === true;
  assertUniqueBundleNames(cloned, options.catalog, replace);
  const index = registryIndex(options.catalog, cloned, options.toolIndex);
  for (const def of cloned) {
    assertValidFlowDefinition(def, index);
  }
  const ordered = topoSortFlowDefinitions(cloned);
  const added: string[] = [];
  const replaced = new Map<string, Flow>();
  const persisted: string[] = [];
  const priorActives = new Map<string, FlowDefinitionVersion | null>();
  const registered: Flow[] = [];
  try {
    for (const def of ordered) {
      const prior = options.catalog.getDynamic(def.name);
      const flow = rehydrateFlow(def, { tools: options.tools, mode: 'strict' });
      options.catalog.register(flow);
      if (prior) replaced.set(def.name, prior);
      else added.push(def.name);
      registered.push(flow);
    }
    if (options.store) {
      for (const name of replaced.keys()) {
        priorActives.set(name, await options.store.getActive(name));
      }
      for (const def of ordered) {
        const provenance = provenances.get(def.name);
        const version = await options.store.createVersion(def, {
          ...(provenance
            ? {
                compilerModelId: provenance.modelId,
                compilerPromptHash: provenance.promptHash,
                compilerVersion: provenance.compilerVersion,
              }
            : {}),
        });
        persisted.push(def.name);
        await options.store.setActive(def.name, version.versionId);
        const live = options.catalog.getDynamic(def.name);
        if (live) live.versionId = version.versionId;
      }
    }
    return registered;
  } catch (error) {
    options.catalog.rollbackDynamic(added, replaced);
    if (options.store) {
      for (const name of persisted) {
        try {
          const priorActive = priorActives.get(name);
          if (priorActive) {
            await options.store.setActive(name, priorActive.versionId);
          } else {
            await options.store.archive(name);
          }
        } catch (compensateError) {
          const message =
            compensateError instanceof Error ? compensateError.message : String(compensateError);
          console.warn(
            `[flows] Failed to compensate "${name}" after bundle persist failure: ${message}`,
          );
        }
      }
    }
    throw error;
  }
}

export interface LoadDynamicFlowsOptions {
  catalog: LiveFlowCatalog;
  store: FlowDefinitionsStore;
  tools: (id: string) => AnyTool | undefined;
  toolIndex: NonNullable<FlowRegistryIndex['tools']>;
}

export async function loadDynamicFlowsIntoCatalog(
  options: LoadDynamicFlowsOptions,
): Promise<void> {
  const rows = await options.store.list({ status: 'active' });
  const byName = new Map(rows.map((row) => [row.name, row]));
  let ordered: FlowDefinition[];
  try {
    ordered = topoSortFlowDefinitions(rows.map((row) => row.definition));
  } catch (error) {
    if (!(error instanceof FlowCycleError)) throw error;
    console.warn('[flows] Active stored flows have circular nested references; loading in store order');
    ordered = rows.map((row) => row.definition);
  }

  const index = registryIndex(options.catalog, ordered, options.toolIndex);
  for (const def of ordered) {
    try {
      if (options.catalog.hasCodeFlow(def.name)) {
        console.warn(
          `[flows] Skipping stored flow "${def.name}": a code-configured flow already uses that name`,
        );
        continue;
      }
      const issues = validateFlowDefinition(def, index);
      if (issues.length > 0) {
        console.warn(
          `[flows] Skipping invalid stored flow "${def.name}":\n${formatFlowValidationIssues(issues)}`,
        );
        continue;
      }
      const flow = rehydrateFlow(def, {
        tools: options.tools,
        mode: 'lenient',
        onUnsupportedSchema: 'warn',
      });
      const row = byName.get(def.name);
      if (row) flow.versionId = row.versionId;
      options.catalog.register(flow);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[flows] Skipping invalid stored flow "${def.name}": ${message}`);
    }
  }
}
