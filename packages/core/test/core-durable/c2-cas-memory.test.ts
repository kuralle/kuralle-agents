import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { openRun } from '../../src/runtime/openRun.js';
import type { SessionStore } from '../../src/session/SessionStore.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { runSessionStoreCasContract } from '../../src/session/testing.js';
import type { Session } from '../../src/types/session.js';
import { stubModel } from './helpers.js';

class InterleavingStore implements SessionStore {
  readonly inner = new MemoryStore();
  private injected = false;

  get(id: string) { return this.inner.get(id); }
  delete(id: string) { return this.inner.delete(id); }
  list(userId?: string) { return this.inner.list(userId); }

  async save(session: Session): Promise<void> {
    const hasUserMessage = session.messages.some((message) => message.role === 'user');
    if (!this.injected && hasUserMessage) {
      this.injected = true;
      const concurrent = await this.inner.get(session.id);
      if (!concurrent) throw new Error('Expected session before interleaving write');
      concurrent.workingMemory = { concurrentWrite: 'preserve-me' };
      await this.inner.save(concurrent);
    }
    await this.inner.save(session);
  }
}

describe('MemoryStore CAS (C2)', () => {
  runSessionStoreCasContract(() => new MemoryStore());

  it('openRun CAS retry preserves a concurrent session-field write', async () => {
    const store = new InterleavingStore();
    const agent = defineAgent({ id: 'agent', instructions: 'Help.', model: stubModel });

    await openRun(new Map([[agent.id, agent]]), {
      sessionId: 'c2-interleaved-open-run',
      input: 'hello',
      defaultAgentId: agent.id,
      sessionStore: store,
    });

    const saved = await store.get('c2-interleaved-open-run');
    expect(saved?.messages).toContainEqual({ role: 'user', content: 'hello' });
    expect(saved?.workingMemory).toEqual({ concurrentWrite: 'preserve-me' });
  });
});
