import {
  cloneFlowDefinitionVersion,
  FlowDefinitionConflictError,
  FlowDefinitionNameMismatchError,
  FlowDefinitionNotFoundError,
  matchesFlowDefinitionListFilter,
  stampNewFlowDefinitionVersion,
  type CreateVersionOptions,
  type FlowDefinitionListFilter,
  type FlowDefinitionVersion,
  type FlowDefinitionsStore,
} from '../store.js';
import type { FlowDefinition } from '../types.js';

export class MemoryFlowDefinitionsStore implements FlowDefinitionsStore {
  private readonly versions = new Map<string, FlowDefinitionVersion>();
  private readonly digestIndex = new Map<string, string>();

  async createVersion(
    def: FlowDefinition,
    options?: CreateVersionOptions,
  ): Promise<FlowDefinitionVersion> {
    const row = await stampNewFlowDefinitionVersion(def, options);
    const digestKey = `${row.name}\0${row.digest}`;
    if (this.digestIndex.has(digestKey) || this.versions.has(row.versionId)) {
      throw new FlowDefinitionConflictError(row.name, row.digest);
    }
    this.digestIndex.set(digestKey, row.versionId);
    this.versions.set(row.versionId, cloneFlowDefinitionVersion(row));
    return cloneFlowDefinitionVersion(row);
  }

  async setActive(name: string, versionId: string): Promise<FlowDefinitionVersion> {
    const target = this.versions.get(versionId);
    if (!target) throw new FlowDefinitionNotFoundError({ versionId });
    if (target.name !== name) {
      throw new FlowDefinitionNameMismatchError(versionId, name, target.name);
    }
    for (const row of this.versions.values()) {
      if (row.name !== name) continue;
      row.status = row.versionId === versionId ? 'active' : 'superseded';
    }
    return cloneFlowDefinitionVersion(this.versions.get(versionId)!);
  }

  async getActive(name: string): Promise<FlowDefinitionVersion | null> {
    for (const row of this.versions.values()) {
      if (row.name === name && row.status === 'active') {
        return cloneFlowDefinitionVersion(row);
      }
    }
    return null;
  }

  async getVersion(versionId: string): Promise<FlowDefinitionVersion | null> {
    const row = this.versions.get(versionId);
    return row ? cloneFlowDefinitionVersion(row) : null;
  }

  async list(filter?: FlowDefinitionListFilter): Promise<FlowDefinitionVersion[]> {
    const all = [...this.versions.values()];
    return all
      .filter(row => matchesFlowDefinitionListFilter(row, all, filter))
      .sort(compareVersions)
      .map(cloneFlowDefinitionVersion);
  }

  async archive(name: string): Promise<void> {
    let found = false;
    for (const row of this.versions.values()) {
      if (row.name !== name) continue;
      row.status = 'archived';
      found = true;
    }
    if (!found) throw new FlowDefinitionNotFoundError({ name });
  }
}

function compareVersions(a: FlowDefinitionVersion, b: FlowDefinitionVersion): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return b.versionId.localeCompare(a.versionId);
}
