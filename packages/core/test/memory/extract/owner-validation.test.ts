import { describe, expect, it } from 'bun:test';
import { runExtractors } from '../../../src/memory/extract/runExtractors.js';
import { defineExtractor } from '../../../src/memory/extract/defineExtractor.js';
import { InMemoryExtractedValueStore } from '../../../src/memory/extract/InMemoryExtractedValueStore.js';
import { z } from 'zod';

/**
 * The two memory subsystems must agree about the same owner.
 *
 * `wireWorkingMemory` withholds its blocks when the owner is outside the
 * allow-list. Extraction did not check at all, so for `alice/bob` the agent
 * refused to keep working-memory notes while cheerfully writing a facts row —
 * and preload then read that row back, so the customer *was* remembered by the
 * half nobody had guarded.
 *
 * Nothing caught it. Every unit test exercises one subsystem, and each looked
 * correct alone; a live multi-tenant run found it in one turn. These tests pin
 * the agreement so the next change to either side has to keep it.
 */
const probe = defineExtractor({
  name: 'Probe',
  scope: 'user',
  instructions: 'Extract nothing of consequence.',
  schema: z.object({ value: z.string() }),
});

function ctxFor(userId: string | undefined) {
  return {
    sessionId: 'sess-1',
    agentId: 'agent-a',
    userId,
    emit: () => {},
  } as unknown as Parameters<typeof runExtractors>[0]['ctx'];
}

/** Fails the test if the model is ever reached — an invalid owner must stop earlier. */
const unreachableModel = new Proxy(
  {},
  {
    get() {
      throw new Error('the model was called for an owner extraction should have refused');
    },
  },
) as never;

describe('extraction refuses the owners working memory refuses', () => {
  it('does not write a row for an owner outside the allow-list', async () => {
    const store = new InMemoryExtractedValueStore();
    const result = await runExtractors({
      extractors: [probe],
      store,
      model: unreachableModel,
      messages: [{ role: 'user', content: 'hello' }],
      ctx: ctxFor('alice/bob'),
    });

    expect(result.values).toEqual({});
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain('alice/bob');
    // and nothing reached the store, under that owner or any sanitised variant
    expect(await store.load('user', 'alice/bob', probe.slug)).toBeNull();
    expect(await store.load('user', 'alice_bob', probe.slug)).toBeNull();
  });

  it('reports a malformed owner differently from an absent one', async () => {
    const store = new InMemoryExtractedValueStore();
    const absent = await runExtractors({
      extractors: [probe],
      store,
      model: unreachableModel,
      messages: [{ role: 'user', content: 'hello' }],
      ctx: ctxFor(undefined),
    });
    // Both refuse, but an operator fixing them does opposite things: one needs a
    // userId supplied, the other needs the one already supplied cleaned up.
    expect(absent.failures[0]!.error).toContain('no resolvable owner');
    expect(absent.failures[0]!.error).not.toContain('outside');
  });

  it('still runs for the separator-bearing ids real providers issue', async () => {
    // These must NOT be refused — they are exactly the ids the allow-list was
    // widened to keep, and refusing them would break real deployments.
    for (const userId of ['maya@example.com', 'google-oauth2|123', 'tenant:acme', 'u~1', 'u+1']) {
      const store = new InMemoryExtractedValueStore();
      let reached = false;
      const model = new Proxy(
        {},
        {
          get() {
            reached = true;
            throw new Error('stop here — reaching the model is all this asserts');
          },
        },
      ) as never;

      // The probe model throws on first touch, and `runExtractors` only guards
      // the generate call itself — the prompt-cache step reaches the model
      // earlier. Catching here is the point: what is asserted is that the model
      // was reached at all, i.e. that the owner was accepted.
      await runExtractors({
        extractors: [probe],
        store,
        model,
        messages: [{ role: 'user', content: 'hello' }],
        ctx: ctxFor(userId),
      }).catch(() => {});

      expect(reached).toBe(true);
    }
  });
});
