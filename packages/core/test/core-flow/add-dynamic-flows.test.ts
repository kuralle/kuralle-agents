import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import {
  FlowCycleError,
  FlowNameConflictError,
  LiveFlowCatalog,
} from '../../src/flows/liveFlowCatalog.js';
import {
  agentToolSurface,
  loadDynamicFlowsIntoCatalog,
  registerDynamicFlowBundle,
  topoSortFlowDefinitions,
} from '../../src/flows/addDynamicFlows.js';
import { sampleFlowDefinition } from '../../src/flows/definition/testing.js';
import { MemoryFlowDefinitionsStore } from '../../src/flows/definition/stores/MemoryFlowDefinitionsStore.js';
import type { FlowDefinition } from '../../src/flows/definition/types.js';
import type {
  CreateVersionOptions,
  FlowDefinitionListFilter,
  FlowDefinitionVersion,
  FlowDefinitionsStore,
} from '../../src/flows/definition/store.js';
import { stubModel } from '../core-durable/helpers.js';
import type { AgentConfig } from '../../src/types/agentConfig.js';
import type { AnyTool } from '../../src/types/effectTool.js';
import { defineFlow, reply } from '../../src/types/flow.js';

const ping = defineTool({
  name: 'ping',
  description: 'ping',
  execute: async () => ({ ok: true }),
});

function agentWithPing(): AgentConfig {
  return defineAgent({
    id: 'clerk',
    model: stubModel,
    tools: { ping },
  });
}

function toolsOf(agent: AgentConfig): (id: string) => AnyTool | undefined {
  const surface: Record<string, AnyTool> = { ...(agent.tools ?? {}), ...(agent.globalTools ?? {}) };
  return (id) => surface[id] ?? Object.values(surface).find((tool) => tool.name === id);
}

function toolIndexOf(agent: AgentConfig): Record<string, { id: string }> {
  const tools: Record<string, { id: string }> = {};
  for (const [id, tool] of Object.entries({ ...(agent.tools ?? {}), ...(agent.globalTools ?? {}) })) {
    tools[id] = { id: tool.name ?? id };
    if (tool.name && tool.name !== id) tools[tool.name] = { id: tool.name };
  }
  return tools;
}

function nested(name: string, flowId: string): FlowDefinition {
  return sampleFlowDefinition({
    name,
    description: `${name} nests ${flowId}`,
    start: 'pick',
    nodes: [
      {
        kind: 'decide',
        id: 'pick',
        instructions: 'pick',
        choices: [{ id: 'go', label: 'Go', flow: { flowId, cta: 'Open' } }],
        otherwise: { end: 'done' },
      },
    ],
  });
}

function codeIntakeCatalog(): LiveFlowCatalog {
  const start = reply({ id: 'hi', instructions: 'code', next: () => ({ end: 'done' }) });
  return new LiveFlowCatalog([
    defineFlow({ name: 'intake', description: 'code', start, nodes: [start] }),
  ]);
}

function throwingStore(
  failOn: number,
  inner: FlowDefinitionsStore = new MemoryFlowDefinitionsStore(),
): FlowDefinitionsStore & { creates: number } {
  const wrapped: FlowDefinitionsStore & { creates: number } = {
    creates: 0,
    async createVersion(def: FlowDefinition, options?: CreateVersionOptions) {
      wrapped.creates += 1;
      if (wrapped.creates === failOn) {
        throw new Error(`injected persist failure on createVersion #${failOn}`);
      }
      return inner.createVersion(def, options);
    },
    setActive: (name, versionId) => inner.setActive(name, versionId),
    getActive: (name) => inner.getActive(name),
    getVersion: (versionId) => inner.getVersion(versionId),
    list: (filter) => inner.list(filter),
    archive: (name) => inner.archive(name),
  };
  return wrapped;
}

const bundleOpts = (catalog: LiveFlowCatalog, store?: FlowDefinitionsStore) => {
  const agent = agentWithPing();
  return {
    defs: [] as FlowDefinition[],
    catalog,
    tools: toolsOf(agent),
    toolIndex: toolIndexOf(agent),
    store,
  };
};

describe('registerDynamicFlowBundle atomicity', () => {
  it('registers nothing and persists nothing when one member is invalid', async () => {
    const catalog = new LiveFlowCatalog([]);
    const store = new MemoryFlowDefinitionsStore();
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [
          sampleFlowDefinition({ name: 'alpha' }),
          sampleFlowDefinition({
            name: 'broken',
            start: 'missing',
            nodes: [{ kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } }],
          }),
        ],
      }),
    ).rejects.toThrow(/failed validation/);

    expect(catalog.get('alpha')).toBeUndefined();
    expect(catalog.get('broken')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('registers nothing when a member references an unknown tool', async () => {
    const catalog = new LiveFlowCatalog([]);
    const store = new MemoryFlowDefinitionsStore();
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [
          sampleFlowDefinition({
            name: 'needs_tool',
            start: 'act',
            nodes: [{ kind: 'action', id: 'act', tool: 'not_a_tool', next: { end: 'done' } }],
          }),
        ],
      }),
    ).rejects.toThrow(/not a registered tool/);

    expect(catalog.get('needs_tool')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('restores the prior catalog when persistence fails partway', async () => {
    const catalog = new LiveFlowCatalog([]);
    const memory = new MemoryFlowDefinitionsStore();
    await registerDynamicFlowBundle({
      ...bundleOpts(catalog, memory),
      defs: [sampleFlowDefinition({ name: 'kept' })],
    });
    expect(catalog.get('kept')).toBeDefined();

    const store = throwingStore(2);
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [sampleFlowDefinition({ name: 'beta' }), sampleFlowDefinition({ name: 'gamma' })],
      }),
    ).rejects.toThrow(/injected persist failure/);

    expect(catalog.get('kept')).toBeDefined();
    expect(catalog.get('beta')).toBeUndefined();
    expect(catalog.get('gamma')).toBeUndefined();
  });

  it('rejects a bundle member that shadows a code flow', async () => {
    const catalog = codeIntakeCatalog();
    const store = new MemoryFlowDefinitionsStore();
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [sampleFlowDefinition({ name: 'intake' })],
      }),
    ).rejects.toThrow(FlowNameConflictError);
    expect(await store.list()).toEqual([]);
    expect(catalog.get('intake')?.description).toBe('code');
  });

  it('rejects circular nested-flow references before registering', async () => {
    const catalog = new LiveFlowCatalog([]);
    const store = new MemoryFlowDefinitionsStore();
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [nested('one', 'two'), nested('two', 'one')],
      }),
    ).rejects.toThrow(FlowCycleError);
    expect(catalog.list()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('delta rollback does not erase a concurrent bundle that committed during persist', async () => {
    const catalog = new LiveFlowCatalog([]);
    const inner = new MemoryFlowDefinitionsStore();
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aEntered!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      aEntered = resolve;
    });
    const store: FlowDefinitionsStore = {
      async createVersion(def, options) {
        if (def.name === 'bundle-a') {
          aEntered();
          await gateA;
          throw new Error('injected persist failure for bundle-a after B committed');
        }
        return inner.createVersion(def, options);
      },
      setActive: (name, versionId) => inner.setActive(name, versionId),
      getActive: (name) => inner.getActive(name),
      getVersion: (versionId) => inner.getVersion(versionId),
      list: (filter) => inner.list(filter),
      archive: (name) => inner.archive(name),
    };

    const aDone = registerDynamicFlowBundle({
      ...bundleOpts(catalog, store),
      defs: [sampleFlowDefinition({ name: 'bundle-a' })],
    });
    await aStarted;
    await registerDynamicFlowBundle({
      ...bundleOpts(catalog, store),
      defs: [sampleFlowDefinition({ name: 'bundle-b' })],
    });
    expect(catalog.get('bundle-b')).toBeDefined();
    releaseA();
    await expect(aDone).rejects.toThrow(/injected persist failure for bundle-a/);
    expect(catalog.get('bundle-b')).toBeDefined();
    expect(catalog.get('bundle-a')).toBeUndefined();
  });

  it('topo-sorts so persist order is independent of bundle order', async () => {
    const names: string[] = [];
    const inner = new MemoryFlowDefinitionsStore();
    const store: FlowDefinitionsStore = {
      async createVersion(def, options) {
        names.push(def.name);
        return inner.createVersion(def, options);
      },
      setActive: (name, versionId) => inner.setActive(name, versionId),
      getActive: (name) => inner.getActive(name),
      getVersion: (versionId) => inner.getVersion(versionId),
      list: (filter) => inner.list(filter),
      archive: (name) => inner.archive(name),
    };
    const catalog = new LiveFlowCatalog([]);
    await registerDynamicFlowBundle({
      ...bundleOpts(catalog, store),
      defs: [nested('parent', 'child'), sampleFlowDefinition({ name: 'child' })],
    });
    expect(names.indexOf('child')).toBeLessThan(names.indexOf('parent'));
    expect(
      topoSortFlowDefinitions([
        nested('parent', 'child'),
        sampleFlowDefinition({ name: 'child' }),
      ]).map((def) => def.name),
    ).toEqual(['child', 'parent']);
  });
});

describe('loadDynamicFlowsIntoCatalog boot', () => {
  it('loads active rows, skips corrupt ones, and does not shadow code flows', async () => {
    const active = (name: string, def: FlowDefinition): FlowDefinitionVersion => ({
      versionId: name,
      name,
      description: def.description,
      definition: def,
      digest: name,
      status: 'active',
      createdAt: new Date(),
    });
    const store: FlowDefinitionsStore = {
      createVersion: async () => {
        throw new Error('boot must not write');
      },
      setActive: async () => {
        throw new Error('boot must not write');
      },
      getActive: async () => null,
      getVersion: async () => null,
      archive: async () => {
        throw new Error('boot must not write');
      },
      async list(filter?: FlowDefinitionListFilter) {
        if (filter?.status !== 'active') return [];
        return [
          active('live', sampleFlowDefinition({ name: 'live' })),
          active(
            'corrupt',
            sampleFlowDefinition({
              name: 'corrupt',
              start: 'missing',
              nodes: [{ kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } }],
            }),
          ),
          active('intake', sampleFlowDefinition({ name: 'intake', description: 'stored' })),
        ];
      },
    };

    const catalog = codeIntakeCatalog();
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await loadDynamicFlowsIntoCatalog({
        catalog,
        store,
        tools: toolsOf(agentWithPing()),
        toolIndex: toolIndexOf(agentWithPing()),
      });
    } finally {
      console.warn = orig;
    }

    expect(catalog.get('live')).toBeDefined();
    expect(catalog.get('corrupt')).toBeUndefined();
    expect(catalog.get('intake')?.description).toBe('code');
    expect(warnings.some((line) => line.includes('corrupt'))).toBe(true);
    expect(warnings.some((line) => line.includes('intake'))).toBe(true);
  });
});

describe('agentToolSurface harness merge', () => {
  it('includes harness tools and lets the agent win on collision', () => {
    const harnessPing = defineTool({
      name: 'harness_ping',
      description: 'harness',
      execute: async () => ({ ok: true }),
    });
    const harnessClash = defineTool({
      name: 'ping',
      description: 'harness clash',
      execute: async () => ({ ok: true }),
    });
    const agent = agentWithPing();
    const surface = agentToolSurface(agent, { harness_ping: harnessPing, ping: harnessClash });
    expect(surface.lookup('harness_ping')).toBe(harnessPing);
    expect(surface.lookup('ping')).toBe(ping);
    expect(surface.index.harness_ping).toEqual({ id: 'harness_ping' });
    expect(surface.index.ping).toEqual({ id: 'ping' });
  });
});

describe('registerDynamicFlowBundle replace', () => {
  it('rejects reuse of an existing dynamic name unless replace is true', async () => {
    const catalog = new LiveFlowCatalog([]);
    await registerDynamicFlowBundle({
      ...bundleOpts(catalog),
      defs: [sampleFlowDefinition({ name: 'refund', description: 'v1' })],
    });
    const prior = catalog.get('refund');
    expect(prior).toBeDefined();

    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog),
        defs: [sampleFlowDefinition({ name: 'refund', description: 'v2' })],
      }),
    ).rejects.toThrow(FlowNameConflictError);
    expect(catalog.get('refund')).toBe(prior);

    const [replaced] = await registerDynamicFlowBundle({
      ...bundleOpts(catalog),
      defs: [sampleFlowDefinition({ name: 'refund', description: 'v2' })],
      replace: true,
    });
    expect(catalog.get('refund')).toBe(replaced);
    expect(catalog.get('refund')).not.toBe(prior);
    expect(catalog.get('refund')?.description).toBe('v2');
  });

  it('a failed replace restores the exact prior Flow object', async () => {
    const catalog = new LiveFlowCatalog([]);
    await registerDynamicFlowBundle({
      ...bundleOpts(catalog),
      defs: [sampleFlowDefinition({ name: 'refund', description: 'v1' })],
    });
    const prior = catalog.get('refund');
    const store = throwingStore(1);
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [sampleFlowDefinition({ name: 'refund', description: 'v2' })],
        replace: true,
      }),
    ).rejects.toThrow(/injected persist failure/);
    expect(catalog.get('refund')).toBe(prior);
    expect(catalog.get('refund')?.description).toBe('v1');
  });
});

describe('registerDynamicFlowBundle persist compensation', () => {
  it('a failed replace-bundle after persisting the successor restores the prior active version so boot reloads v1', async () => {
    const catalog = new LiveFlowCatalog([]);
    const inner = new MemoryFlowDefinitionsStore();
    await registerDynamicFlowBundle({
      ...bundleOpts(catalog, inner),
      defs: [sampleFlowDefinition({ name: 'refund', description: 'v1' })],
    });
    const v1 = await inner.getActive('refund');
    expect(v1).not.toBeNull();
    expect(v1?.definition.description).toBe('v1');

    // Persist order is topo/alpha: refund then zeta. throwingStore(2) fails after refund v2 is active.
    const store = throwingStore(2, inner);
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [
          sampleFlowDefinition({ name: 'refund', description: 'v2' }),
          sampleFlowDefinition({ name: 'zeta', description: 'new' }),
        ],
        replace: true,
      }),
    ).rejects.toThrow(/injected persist failure/);

    const restored = await store.getActive('refund');
    expect(restored).not.toBeNull();
    expect(restored?.versionId).toBe(v1!.versionId);
    expect(restored?.definition.description).toBe('v1');
    expect(await store.getActive('zeta')).toBeNull();
    expect(catalog.get('refund')?.description).toBe('v1');
    expect(catalog.get('zeta')).toBeUndefined();

    const booted = new LiveFlowCatalog([]);
    await loadDynamicFlowsIntoCatalog({
      catalog: booted,
      store,
      tools: toolsOf(agentWithPing()),
      toolIndex: toolIndexOf(agentWithPing()),
    });
    expect(booted.get('refund')?.description).toBe('v1');
    expect(booted.get('zeta')).toBeUndefined();
  });

  it('archives members already persisted in a failed bundle so boot does not resurrect them', async () => {
    const catalog = new LiveFlowCatalog([]);
    const store = throwingStore(2);
    await expect(
      registerDynamicFlowBundle({
        ...bundleOpts(catalog, store),
        defs: [sampleFlowDefinition({ name: 'beta' }), sampleFlowDefinition({ name: 'gamma' })],
      }),
    ).rejects.toThrow(/injected persist failure/);

    expect(catalog.get('beta')).toBeUndefined();
    expect(catalog.get('gamma')).toBeUndefined();
    expect(await store.getActive('beta')).toBeNull();
    expect(await store.getActive('gamma')).toBeNull();

    const booted = new LiveFlowCatalog([]);
    await loadDynamicFlowsIntoCatalog({
      catalog: booted,
      store,
      tools: toolsOf(agentWithPing()),
      toolIndex: toolIndexOf(agentWithPing()),
    });
    expect(booted.get('beta')).toBeUndefined();
    expect(booted.get('gamma')).toBeUndefined();
  });

  it('does not mask the original persist error when archive also fails', async () => {
    const catalog = new LiveFlowCatalog([]);
    const store = throwingStore(2);
    store.archive = async () => {
      throw new Error('archive boom');
    };
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await expect(
        registerDynamicFlowBundle({
          ...bundleOpts(catalog, store),
          defs: [sampleFlowDefinition({ name: 'beta' }), sampleFlowDefinition({ name: 'gamma' })],
        }),
      ).rejects.toThrow(/injected persist failure/);
    } finally {
      console.warn = orig;
    }
    expect(warnings.some((line) => line.includes('beta') && line.includes('archive boom'))).toBe(true);
  });
});
