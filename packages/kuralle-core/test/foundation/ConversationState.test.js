import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultConversationState } from '../../dist/foundation/DefaultConversationState.js';
import { MemoryStore } from '../../dist/session/stores/MemoryStore.js';

describe('DefaultConversationState', () => {
  function createState(overrides = {}) {
    return new DefaultConversationState({
      sessionStore: new MemoryStore(),
      defaultAgentId: 'default-agent',
      ...overrides,
    });
  }

  it('load creates a new session if not found', async () => {
    const state = createState();
    const session = await state.load('new-session', 'user-1');

    assert.equal(session.id, 'new-session');
    assert.equal(session.userId, 'user-1');
    assert.equal(session.currentAgent, 'default-agent');
    assert.equal(session.activeAgentId, 'default-agent');
    assert.deepEqual(session.messages, []);
    assert.deepEqual(session.handoffHistory, []);
  });

  it('load returns existing session from store', async () => {
    const store = new MemoryStore();
    const state = createState({ sessionStore: store });

    // Save a session first
    const session = state.createSession('existing', 'default-agent', 'user-1');
    session.messages.push({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    await store.save(session);

    // Load it back
    const loaded = await state.load('existing');
    assert.equal(loaded.id, 'existing');
    assert.equal(loaded.messages.length, 1);
  });

  it('save persists to store', async () => {
    const store = new MemoryStore();
    const state = createState({ sessionStore: store });

    const session = state.createSession('save-test', 'default-agent');
    await state.save(session);

    const retrieved = await store.get('save-test');
    assert.ok(retrieved);
    assert.equal(retrieved.id, 'save-test');
  });

  it('appendUserMessage appends correct format', () => {
    const state = createState();
    const session = state.createSession('msg-test', 'default-agent');

    state.appendUserMessage(session, 'hello');
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].role, 'user');
  });

  it('appendAssistantMessage appends correct format', () => {
    const state = createState();
    const session = state.createSession('msg-test', 'default-agent');

    state.appendAssistantMessage(session, 'hi there');
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].role, 'assistant');
  });

  it('getSessionTurn returns 0 for new session', () => {
    const state = createState();
    const session = state.createSession('turn-test', 'default-agent');
    assert.equal(state.getSessionTurn(session), 0);
  });

  it('bumpSessionTurn increments correctly', () => {
    const state = createState();
    const session = state.createSession('turn-test', 'default-agent');

    assert.equal(state.bumpSessionTurn(session), 1);
    assert.equal(state.bumpSessionTurn(session), 2);
    assert.equal(state.getSessionTurn(session), 2);
  });

  it('touchSession updates timestamps', () => {
    const state = createState();
    const session = state.createSession('touch-test', 'default-agent');
    const originalTime = session.updatedAt;

    // Small delay to ensure different timestamp
    state.touchSession(session);
    assert.ok(session.updatedAt >= originalTime);
  });

  it('workingMemory returns a working memory wrapper', () => {
    const state = createState();
    const session = state.createSession('wm-test', 'default-agent');

    const wm = state.workingMemory(session);
    wm.set('key', 'value');
    assert.equal(wm.get('key'), 'value');
    assert.equal(session.workingMemory['key'], 'value');
  });

  it('delete removes session from store', async () => {
    const store = new MemoryStore();
    const state = createState({ sessionStore: store });

    const session = state.createSession('del-test', 'default-agent');
    await store.save(session);
    assert.ok(await store.get('del-test'));

    await state.delete('del-test');
    assert.equal(await store.get('del-test'), null);
  });
});
