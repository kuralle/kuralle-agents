import type { AgentConfig } from '../types/agentConfig.js';
import type { Flow } from '../types/flow.js';
import type { RunState } from '../runtime/durable/types.js';
import { addSystemNote } from '../runtime/systemNotes.js';
import { readInternalState, withInternalState } from '../runtime/internalRunState.js';

export const FLOW_CATALOG_NOTE_TAG = 'flow-catalog';

export interface FlowCatalogEntry {
  name: string;
  description: string;
}

export interface FlowCatalogDelta {
  added: FlowCatalogEntry[];
  removed: string[];
}

export interface PersistedLiveFlowCatalog {
  agentId: string;
  announced: FlowCatalogEntry[];
}

export class FlowNameConflictError extends Error {
  readonly name = 'FlowNameConflictError';
  readonly flowName: string;
  readonly reason: 'code' | 'bundle' | 'dynamic';

  constructor(flowName: string, reason: 'code' | 'bundle' | 'dynamic') {
    super(
      reason === 'code'
        ? `Stored flow "${flowName}" may not shadow a code-configured flow`
        : reason === 'dynamic'
          ? `Dynamic flow "${flowName}" already exists; pass replace: true to overwrite`
          : `Duplicate flow name "${flowName}" in bundle`,
    );
    this.flowName = flowName;
    this.reason = reason;
  }
}

export class FlowCycleError extends Error {
  readonly name = 'FlowCycleError';

  constructor() {
    super('Circular nested-flow references in bundle');
  }
}

/**
 * Per-agent live roster: code-configured flows are the baseline; dynamic flows
 * layer on top and must not reuse a baseline name. Shared across sessions of
 * the same runtime — announcement snapshots live on run state, not here.
 */
export class LiveFlowCatalog {
  private readonly dynamic = new Map<string, Flow>();

  constructor(private readonly baseline: readonly Flow[]) {}

  list(): Flow[] {
    const seen = new Set<string>();
    const out: Flow[] = [];
    for (const flow of this.baseline) {
      out.push(flow);
      seen.add(flow.name);
    }
    const extras = [...this.dynamic.values()].filter((flow) => !seen.has(flow.name));
    extras.sort((a, b) => a.name.localeCompare(b.name));
    return [...out, ...extras];
  }

  get(name: string): Flow | undefined {
    const code = this.baseline.find((flow) => flow.name === name);
    if (code) return code;
    return this.dynamic.get(name);
  }

  hasCodeFlow(name: string): boolean {
    return this.baseline.some((flow) => flow.name === name);
  }

  register(flow: Flow): void {
    if (this.hasCodeFlow(flow.name)) {
      throw new FlowNameConflictError(flow.name, 'code');
    }
    this.dynamic.set(flow.name, flow);
  }

  remove(name: string): boolean {
    if (this.hasCodeFlow(name)) return false;
    return this.dynamic.delete(name);
  }

  getDynamic(name: string): Flow | undefined {
    return this.dynamic.get(name);
  }

  /**
   * Undo one bundle's live mutations. Deletes names this bundle added;
   * restores the prior Flow object for names this bundle replaced.
   * Concurrent registrations for other names are left untouched.
   */
  rollbackDynamic(added: readonly string[], replaced: ReadonlyMap<string, Flow>): void {
    for (const name of added) {
      this.dynamic.delete(name);
    }
    for (const [name, flow] of replaced) {
      this.dynamic.set(name, flow);
    }
  }

  overlay(agent: AgentConfig): AgentConfig {
    return { ...agent, flows: this.list() };
  }

  entries(): FlowCatalogEntry[] {
    return this.list()
      .map((flow) => ({ name: flow.name, description: flow.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function findFlowByName(agent: AgentConfig, flowName: string): Flow | undefined {
  return agent.flows?.find((flow) => flow.name === flowName);
}

export function diffFlowCatalog(
  previous: readonly FlowCatalogEntry[],
  next: readonly FlowCatalogEntry[],
): FlowCatalogDelta {
  const prev = new Map(previous.map((entry): [string, FlowCatalogEntry] => [entry.name, entry]));
  const nextMap = new Map(next.map((entry): [string, FlowCatalogEntry] => [entry.name, entry]));

  const added: FlowCatalogEntry[] = [];
  for (const [name, entry] of nextMap) {
    if (!prev.has(name)) added.push({ name: entry.name, description: entry.description });
  }

  const removed: string[] = [];
  for (const name of prev.keys()) {
    if (!nextMap.has(name)) removed.push(name);
  }

  return {
    added: added.sort((a, b) => a.name.localeCompare(b.name)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
  };
}

export function renderFlowCatalogDelta(
  delta: FlowCatalogDelta,
  roster: readonly string[],
): string {
  const lines: string[] = ['The flows available in this run changed.'];

  if (delta.added.length > 0) {
    lines.push('Newly available — call enter_flow by name when the description matches:');
    for (const entry of delta.added) {
      lines.push(`- ${entry.name}: ${entry.description}`);
    }
  }

  if (delta.removed.length > 0) {
    lines.push('No longer available — do not call enter_flow for these:');
    for (const name of delta.removed) {
      lines.push(`- ${name}`);
    }
  }

  const sortedRoster = [...roster].sort();
  if (sortedRoster.length > 0) {
    lines.push(`Current available flows: ${sortedRoster.join(', ')}`);
  } else {
    lines.push('No flows are currently available.');
  }

  return lines.join('\n');
}

function parsePersisted(value: unknown): PersistedLiveFlowCatalog | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { agentId?: unknown; announced?: unknown };
  if (typeof record.agentId !== 'string' || !Array.isArray(record.announced)) return undefined;
  const announced: FlowCatalogEntry[] = [];
  for (const row of record.announced) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as { name?: unknown; description?: unknown };
    if (typeof entry.name !== 'string' || typeof entry.description !== 'string') continue;
    announced.push({ name: entry.name, description: entry.description });
  }
  return { agentId: record.agentId, announced };
}

function writePersisted(runState: RunState, snapshot: PersistedLiveFlowCatalog): void {
  withInternalState(runState.state, (internal) => {
    internal.flowCatalog = snapshot;
  });
}

/**
 * Diff the live roster against the snapshot stored on this run. Writes the new
 * snapshot onto run state. Returns true when run state changed (snapshot and/or
 * note) so the caller can persist. A crash before that write re-diffs next turn.
 */
export function applyFlowCatalogAnnouncement(
  catalog: LiveFlowCatalog,
  agentId: string,
  runState: RunState,
): boolean {
  const current = catalog.entries();
  const persisted = parsePersisted(readInternalState(runState.state).flowCatalog);
  if (!persisted || persisted.agentId !== agentId) {
    writePersisted(runState, { agentId, announced: current });
    return true;
  }
  const delta = diffFlowCatalog(persisted.announced, current);
  if (delta.added.length === 0 && delta.removed.length === 0) return false;
  addSystemNote(runState, renderFlowCatalogDelta(delta, current.map((entry) => entry.name)), {
    lifetime: 'run',
    tag: FLOW_CATALOG_NOTE_TAG,
  });
  writePersisted(runState, { agentId, announced: current });
  return true;
}

export function rebaselineFlowCatalogAnnouncement(
  catalog: LiveFlowCatalog,
  agentId: string,
  runState: RunState,
): void {
  writePersisted(runState, { agentId, announced: catalog.entries() });
}
