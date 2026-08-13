/**
 * Conformance cases every `FlowDefinitionsStore` backend must pass.
 *
 * Framework-neutral so bun:test, vitest, and workerd can wrap the same cases:
 *
 *     for (const c of flowDefinitionsStoreConformanceCases) {
 *       it(c.name, async () => { await c.run(await makeStore()); });
 *     }
 */
import { canonicalJson } from './canonical.js';
import { flowDigest } from './digest.js';
import {
  FlowDefinitionConflictError,
  FlowDefinitionNameMismatchError,
  FlowDefinitionNotFoundError,
  type CreateVersionOptions,
  type FlowDefinitionVersion,
  type FlowDefinitionsStore,
} from './store.js';
import type { FlowDefinition } from './types.js';

export interface FlowDefinitionsStoreConformanceCase {
  name: string;
  run(store: FlowDefinitionsStore): Promise<void>;
}

function fail(message: string): never {
  throw new Error(`FlowDefinitionsStore conformance: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function ids(rows: FlowDefinitionVersion[]): string[] {
  return rows.map(row => row.versionId).sort();
}

export function sampleFlowDefinition(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    name: 'refund',
    description: 'Refund a payment',
    start: 'greet',
    nodes: [{ kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } }],
    ...overrides,
  };
}

function shuffledSchema(): FlowDefinition {
  return sampleFlowDefinition({
    name: 'keyed',
    inputSchema: {
      type: 'object',
      properties: { z: { type: 'string' }, a: { type: 'number' } },
    },
  });
}

function stableSchema(): FlowDefinition {
  return sampleFlowDefinition({
    name: 'keyed',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, z: { type: 'string' } },
    },
  });
}

export const flowDefinitionsStoreConformanceCases: ReadonlyArray<FlowDefinitionsStoreConformanceCase> =
  [
    {
      name: 'createVersion stamps a server digest and superseded status; client status/digest are ignored',
      async run(store) {
        const def = sampleFlowDefinition();
        const version = await store.createVersion(def, {
          authorId: 'alice',
          status: 'active',
          digest: '0'.repeat(64),
        } as CreateVersionOptions);
        assert(version.status === 'superseded', `expected superseded, got ${version.status}`);
        assert(version.digest !== '0'.repeat(64), 'client digest was stored');
        assert(version.digest === (await flowDigest(def)), 'digest does not match flowDigest(def)');
        assert(version.authorId === 'alice', 'authorId was dropped');
        assert(version.createdAt instanceof Date, 'createdAt is not a Date');
        assert((await store.getActive(def.name)) === null, 'createVersion flipped the active pointer');
      },
    },
    {
      name: 'createVersion rejects an invalid definition before insert',
      async run(store) {
        try {
          await store.createVersion(
            sampleFlowDefinition({ start: 'missing', nodes: [{ kind: 'reply', id: 'greet', generate: true, next: { end: 'done' } }] }),
          );
        } catch (error) {
          assert(error instanceof Error, 'expected an Error');
          assert(!(error instanceof FlowDefinitionConflictError), 'invalid definition surfaced as conflict');
          assert((await store.list()).length === 0, 'invalid definition left a row');
          return;
        }
        fail('invalid definition was accepted');
      },
    },
    {
      name: 'two writes to one name yield two versions, one active pointer, superseded still resolvable',
      async run(store) {
        const first = await store.createVersion(sampleFlowDefinition({ description: 'v1' }));
        const second = await store.createVersion(sampleFlowDefinition({ description: 'v2' }));
        assert(first.versionId !== second.versionId, 'versions shared an id');
        assert(first.digest !== second.digest, 'distinct content shared a digest');
        await store.setActive('refund', second.versionId);
        const active = await store.getActive('refund');
        assert(active?.versionId === second.versionId, 'active pointer is not the published version');
        const parked = await store.getVersion(first.versionId);
        assert(parked !== null, 'superseded version was not resolvable by id');
        assert(parked.status === 'superseded', `parked status is ${parked.status}`);
        assert(parked.digest === first.digest, 'superseded digest changed');
        const listed = await store.list({ name: 'refund' });
        assert(listed.length === 2, `expected 2 versions, got ${listed.length}`);
        assert(
          listed.filter(row => row.status === 'active').length === 1,
          'expected exactly one active pointer',
        );
      },
    },
    {
      name: 'setActive supersedes the previous active version',
      async run(store) {
        const first = await store.createVersion(sampleFlowDefinition({ description: 'one' }));
        const second = await store.createVersion(sampleFlowDefinition({ description: 'two' }));
        await store.setActive('refund', first.versionId);
        await store.setActive('refund', second.versionId);
        assert((await store.getActive('refund'))?.versionId === second.versionId, 'second publish missed');
        assert((await store.getVersion(first.versionId))?.status === 'superseded', 'first was not superseded');
      },
    },
    {
      name: 'definition and digest are immutable across setActive and archive',
      async run(store) {
        const created = await store.createVersion(sampleFlowDefinition());
        await store.setActive('refund', created.versionId);
        await store.archive('refund');
        const fetched = await store.getVersion(created.versionId);
        assert(fetched !== null, 'version disappeared');
        assert(fetched.digest === created.digest, 'digest mutated');
        assert(canonicalJson(fetched.definition) === canonicalJson(created.definition), 'definition mutated');
      },
    },
    {
      name: 'insert-only: concurrent create of the same canonical content is a conflict',
      async run(store) {
        const def = shuffledSchema();
        await store.createVersion(def);
        try {
          await store.createVersion(stableSchema());
        } catch (error) {
          assert(error instanceof FlowDefinitionConflictError, `expected FlowDefinitionConflictError, got ${String(error)}`);
          assert((await store.list({ name: 'keyed' })).length === 1, 'conflict clobbered or duplicated the row');
          return;
        }
        fail('same canonical content was inserted twice');
      },
    },
    {
      name: 'digest is stable across object key order',
      async run(store) {
        const left = await flowDigest(shuffledSchema());
        const right = await flowDigest(stableSchema());
        assert(left === right, `digests diverged: ${left} vs ${right}`);
        const version = await store.createVersion(shuffledSchema());
        assert(version.digest === left, 'stored digest does not match canonical digest');
      },
    },
    {
      name: 'archive hides getActive and default list; setActive restores',
      async run(store) {
        const first = await store.createVersion(sampleFlowDefinition({ description: 'keep' }));
        const second = await store.createVersion(sampleFlowDefinition({ description: 'live' }));
        await store.setActive('refund', second.versionId);
        await store.archive('refund');
        assert((await store.getActive('refund')) === null, 'archived name still has an active pointer');
        assert((await store.list()).every(row => row.name !== 'refund'), 'archived name leaked into default list');
        const archived = await store.list({ status: 'archived', name: 'refund' });
        assert(ids(archived).length === 2, `expected 2 archived versions, got ${archived.length}`);
        const restored = await store.setActive('refund', first.versionId);
        assert(restored.status === 'active', 'restore did not activate');
        assert((await store.getActive('refund'))?.versionId === first.versionId, 'restore missed the pointer');
        assert((await store.getVersion(second.versionId))?.status === 'superseded', 'sibling stayed archived');
        assert((await store.list({ name: 'refund' })).length === 2, 'restored name missing from default list');
      },
    },
    {
      name: 'list filters by status, authorId, and name',
      async run(store) {
        const alice = await store.createVersion(sampleFlowDefinition({ name: 'alpha', description: 'a' }), {
          authorId: 'alice',
        });
        await store.createVersion(sampleFlowDefinition({ name: 'beta', description: 'b' }), { authorId: 'bob' });
        await store.setActive('alpha', alice.versionId);
        const byAuthor = await store.list({ authorId: 'alice' });
        assert(byAuthor.every(row => row.authorId === 'alice'), 'authorId filter leaked');
        assert(byAuthor.some(row => row.versionId === alice.versionId), 'alice version missing');
        const byName = await store.list({ name: 'beta' });
        assert(byName.every(row => row.name === 'beta'), 'name filter leaked');
        const active = await store.list({ status: 'active' });
        assert(active.length === 1 && active[0]?.versionId === alice.versionId, 'status=active filter missed');
      },
    },
    {
      name: 'getVersion / getActive of missing ids return null; setActive / archive of unknown throw',
      async run(store) {
        assert((await store.getVersion('missing')) === null, 'missing version was not null');
        assert((await store.getActive('missing')) === null, 'missing active was not null');
        try {
          await store.setActive('refund', 'missing');
        } catch (error) {
          assert(error instanceof FlowDefinitionNotFoundError, `expected not found, got ${String(error)}`);
          try {
            await store.archive('missing');
          } catch (archiveError) {
            assert(archiveError instanceof FlowDefinitionNotFoundError, `expected not found, got ${String(archiveError)}`);
            return;
          }
          fail('archive of unknown name succeeded');
        }
        fail('setActive of unknown version succeeded');
      },
    },
    {
      name: 'setActive rejects a version that belongs to another name',
      async run(store) {
        const alpha = await store.createVersion(sampleFlowDefinition({ name: 'alpha' }));
        await store.createVersion(sampleFlowDefinition({ name: 'beta' }));
        try {
          await store.setActive('beta', alpha.versionId);
        } catch (error) {
          assert(
            error instanceof FlowDefinitionNameMismatchError,
            `expected FlowDefinitionNameMismatchError, got ${String(error)}`,
          );
          return;
        }
        fail('setActive accepted a name mismatch');
      },
    },
    {
      name: 'returned versions do not alias stored definition objects',
      async run(store) {
        const created = await store.createVersion(sampleFlowDefinition());
        created.definition.description = 'mutated';
        const fetched = await store.getVersion(created.versionId);
        assert(fetched?.definition.description === 'Refund a payment', 'store aliased the definition');
      },
    },
  ];
