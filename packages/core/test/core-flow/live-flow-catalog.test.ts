import { describe, expect, it } from 'bun:test';
import { defineFlow, reply } from '../../src/types/flow.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import {
  FLOW_CATALOG_NOTE_TAG,
  FlowNameConflictError,
  LiveFlowCatalog,
  applyFlowCatalogAnnouncement,
  diffFlowCatalog,
  findFlowByName,
} from '../../src/flows/liveFlowCatalog.js';
import { availableHostFlows, buildHostControlTools } from '../../src/runtime/hostControlTools.js';
import { makeRunState, stubModel } from '../core-durable/helpers.js';
import { systemNoteBlocks } from '../../src/runtime/systemNotes.js';
import type { Flow } from '../../src/types/flow.js';

function namedFlow(name: string, description: string): Flow {
  const node = reply({ id: `${name}-node`, instructions: description, next: () => ({ end: 'done' }) });
  return defineFlow({ name, description, start: node, nodes: [node] });
}

const codeFlow = namedFlow('intake', 'Code intake');
const dynamicFlow = namedFlow('refund', 'Dynamic refund');

describe('LiveFlowCatalog', () => {
  it('layers dynamic flows under code flows and resolves by name', () => {
    const catalog = new LiveFlowCatalog([codeFlow]);
    catalog.register(dynamicFlow);
    expect(catalog.list().map((flow) => flow.name).sort()).toEqual(['intake', 'refund']);
    expect(catalog.get('refund')).toBe(dynamicFlow);
    expect(catalog.get('intake')).toBe(codeFlow);
    const agent = defineAgent({ id: 'clerk', model: stubModel, flows: [codeFlow] });
    const live = catalog.overlay(agent);
    expect(findFlowByName(live, 'refund')).toBe(dynamicFlow);
    expect(findFlowByName(live, 'intake')).toBe(codeFlow);
  });

  it('rejects a stored flow that shadows a code flow', () => {
    const catalog = new LiveFlowCatalog([codeFlow]);
    expect(() => catalog.register(namedFlow('intake', 'shadow'))).toThrow(FlowNameConflictError);
    expect(catalog.get('intake')).toBe(codeFlow);
    expect(catalog.list()).toEqual([codeFlow]);
  });

  it('remove clears live registration only', () => {
    const catalog = new LiveFlowCatalog([codeFlow]);
    catalog.register(dynamicFlow);
    expect(catalog.remove('refund')).toBe(true);
    expect(catalog.get('refund')).toBeUndefined();
    expect(catalog.remove('intake')).toBe(false);
    expect(catalog.get('intake')).toBe(codeFlow);
  });

  it('delta rollback restores only this bundle\'s mutations', () => {
    const catalog = new LiveFlowCatalog([codeFlow]);
    catalog.register(dynamicFlow);
    const prior = catalog.get('refund')!;
    catalog.register(namedFlow('other', 'other'));
    catalog.register(namedFlow('refund', 'replacement'));
    catalog.rollbackDynamic(['other'], new Map([['refund', prior]]));
    expect(catalog.get('refund')).toBe(prior);
    expect(catalog.get('other')).toBeUndefined();
  });

  it('overlay feeds enter_flow and the host flow list', () => {
    const catalog = new LiveFlowCatalog([]);
    catalog.register(dynamicFlow);
    const agent = catalog.overlay(defineAgent({ id: 'clerk', model: stubModel }));
    const run = makeRunState('live-catalog', 'live-catalog-run');
    expect(availableHostFlows(agent, run).map((flow) => flow.name)).toEqual(['refund']);
    expect(buildHostControlTools(agent, run)).toHaveProperty('enter_flow');
  });
});

describe('flow catalog announcement', () => {
  it('announces a delta once and is a no-op on the next apply', () => {
    const catalog = new LiveFlowCatalog([]);
    const runState = makeRunState('announce', 'announce-run');
    expect(applyFlowCatalogAnnouncement(catalog, 'clerk', runState)).toBe(true);
    expect(systemNoteBlocks(runState)).toHaveLength(0);

    catalog.register(dynamicFlow);
    expect(applyFlowCatalogAnnouncement(catalog, 'clerk', runState)).toBe(true);
    const notes = systemNoteBlocks(runState);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Newly available');
    expect(notes[0]).toContain('- refund: Dynamic refund');
    expect(notes[0]).toContain('Current available flows: refund');

    expect(applyFlowCatalogAnnouncement(catalog, 'clerk', runState)).toBe(false);
    expect(systemNoteBlocks(runState)).toHaveLength(1);
  });

  it('diff is name-set only and tagged for prompt-cache notes', () => {
    const delta = diffFlowCatalog(
      [{ name: 'intake', description: 'old' }],
      [{ name: 'intake', description: 'new' }, { name: 'refund', description: 'Dynamic refund' }],
    );
    expect(delta.added).toEqual([{ name: 'refund', description: 'Dynamic refund' }]);
    expect(delta.removed).toEqual([]);
    expect(FLOW_CATALOG_NOTE_TAG).toBe('flow-catalog');
  });
});
