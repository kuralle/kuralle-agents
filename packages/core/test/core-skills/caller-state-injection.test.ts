import { describe, expect, it } from 'bun:test';
import { INTERNAL_STATE_KEY, readInternalState, stripInternalKeys, withInternalState } from '../../src/runtime/internalRunState.js';
import { mergeResolvedSkills, readResolvedSkillsCache } from '../../src/skills/resolvedSkillsState.js';

/**
 * `runState.state` is a shared bag: flows write their own keys there, and `openRun`
 * shallow-merges caller-supplied `selection.formData` into it. Framework internals living at
 * the root of that bag meant a request body could overwrite them.
 *
 * Proven exploitable before the fix: `formData: { resolvedSkills: { <agentId>: { "0": [...] } } }`
 * replaced the per-tenant skill snapshot wholesale — the resolver never ran, the tenant's real
 * skills vanished from the prompt, and attacker-chosen skill bodies reached the model.
 */
describe('caller-supplied formData cannot reach framework run state', () => {
  const evil = [{ name: 'attacker-skill', description: 'Injected.', body: 'ATTACKER BODY' }];

  it('leaves a root-level resolvedSkills key where the framework will not read it', () => {
    // The caller may still SET a root key of that name — it is an ordinary flow key now —
    // but the framework reads only from the reserved namespace, so it is inert.
    const state: Record<string, unknown> = { resolvedSkills: { victim: { '0': evil } } };
    expect(readResolvedSkillsCache(state, 'victim')).toBeUndefined();
  });

  it('strips the reserved namespace out of caller formData', () => {
    const safe = stripInternalKeys({ __kuralle: { resolvedSkills: {} }, customerTier: 'gold' });
    expect(Object.hasOwn(safe, INTERNAL_STATE_KEY)).toBe(false);
    expect(safe.customerTier).toBe('gold');
  });

  it('passes ordinary caller data through untouched, and does not reallocate it', () => {
    const input = { customerTier: 'gold', orderId: 'abc' };
    // Same reference back on the common path — the guard must not tax every request.
    expect(stripInternalKeys(input)).toBe(input);
  });

  it('round-trips the framework snapshot through the reserved namespace', () => {
    const state: Record<string, unknown> = {};
    const snapshot = { '0': [{ name: 'tenant-only', description: 'd', body: 'REAL' }] };
    expect(mergeResolvedSkills(state, 'victim', snapshot)).toBe(true);
    expect(readResolvedSkillsCache(state, 'victim')).toEqual(snapshot);
    // and it is genuinely under the reserved key, not at the root
    expect(state.resolvedSkills).toBeUndefined();
    expect(readInternalState(state).resolvedSkills).toBeDefined();
  });

  it('does not re-write when the snapshot is unchanged', () => {
    const state: Record<string, unknown> = {};
    const snapshot = { '0': [{ name: 'a', description: 'd', body: 'b' }] };
    expect(mergeResolvedSkills(state, 'x', snapshot)).toBe(true);
    expect(mergeResolvedSkills(state, 'x', snapshot)).toBe(false);
  });

  it('tolerates a caller who set the reserved key to a non-object', () => {
    // readInternalState must not throw on hostile shapes; it reads as empty.
    for (const junk of ['string', 42, null, [1, 2, 3], true]) {
      expect(readInternalState({ [INTERNAL_STATE_KEY]: junk })).toEqual({});
    }
    const state: Record<string, unknown> = { [INTERNAL_STATE_KEY]: 'not-an-object' };
    withInternalState(state, (i) => { i.skillCatalog = { ok: true }; });
    expect(readInternalState(state).skillCatalog).toEqual({ ok: true });
  });
});

describe('resolver edge shapes (a6 review findings)', () => {
  it('materializing a store carries its resources, not just bodies', async () => {
    const { InlineSkillStore } = await import('../../src/skills/inlineSkillStore.js');
    const { materializeSkillStore } = await import('../../src/skills/materializeSkillStore.js');
    const store = new InlineSkillStore([
      { name: 'with-refs', description: 'd', body: 'B', resources: { 'references/a.md': 'REF A' } },
    ]);
    const { skills } = await materializeSkillStore(store);
    // Without this, a resolver returning a STORE loses every reference file silently.
    expect(skills[0]!.resources?.['references/a.md']).toBe('REF A');
  });

  it('treats a callable object that satisfies SkillStoreLike as a store, not a resolver', async () => {
    const { isSkillResolver } = await import('../../src/skills/skillResolver.js');
    const callableStore = Object.assign(
      function () { throw new Error('a store must never be invoked as a resolver'); },
      {
        list: async () => [],
        loadBody: async () => '',
        loadResource: async () => '',
      },
    );
    expect(isSkillResolver(callableStore as never)).toBe(false);
    // a plain function with no store contract is still a resolver
    expect(isSkillResolver((async () => []) as never)).toBe(true);
  });
});
