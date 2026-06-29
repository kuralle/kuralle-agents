// FINDING 2: Session is a flat message list with no tree/branch/parent fields; SessionStore has no fork/branch API | anchor src/types/session.ts:38, src/session/SessionStore.ts:9 | why this proves it
import { describe, expect, it } from 'bun:test';
import type { Session } from '../../src/types/session.js';
import type { SessionStore } from '../../src/session/SessionStore.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';

type Has<K extends PropertyKey, T> = Extract<keyof T, K> extends never ? false : true;
type _AssertFalse<T extends false> = T;
type _NoSessionTree = _AssertFalse<Has<'parentId' | 'parent' | 'branch' | 'fork', Session>>;
type _NoForkApi = _AssertFalse<
  Has<'fork' | 'branchFrom' | 'branch' | 'createBranch', SessionStore>
>;

// Compile-time contract: adding tree/fork surface to Session or SessionStore fails tsc.
const _sessionTreeContract: _NoSessionTree = false;
const _forkApiContract: _NoForkApi = false;
void _sessionTreeContract;
void _forkApiContract;

const FORK_METHODS = ['fork', 'branchFrom', 'branch', 'createBranch'] as const;

function minimalSession(): Session {
  return {
    id: 'sess-1',
    conversationId: 'conv-1',
    channelId: 'web',
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [{ role: 'user', content: 'hi' }],
    workingMemory: {},
    currentAgent: 'agent-1',
    agentStates: {},
    handoffHistory: [],
  };
}

describe('F2: flat session shape, no fork API on SessionStore', () => {
  it('Session type has messages and no tree/branch/parent keys (compile-time + runtime)', () => {
    const session = minimalSession();
    expect(Array.isArray(session.messages)).toBe(true);
    expect(_sessionTreeContract).toBe(false);
  });

  it('SessionStore interface and MemoryStore expose no fork/branch methods', () => {
    const store: SessionStore = new MemoryStore();
    const proto = Object.getPrototypeOf(store) as object;
    const ownKeys = Object.getOwnPropertyNames(store);
    const protoKeys = Object.getOwnPropertyNames(proto);
    const allKeys = new Set([...ownKeys, ...protoKeys]);

    for (const method of FORK_METHODS) {
      expect(allKeys.has(method)).toBe(false);
      expect(typeof (store as unknown as Record<string, unknown>)[method]).not.toBe('function');
    }

    const contractMethods = ['get', 'save', 'delete', 'list'] as const;
    for (const method of contractMethods) {
      expect(typeof store[method]).toBe('function');
    }
    expect(_forkApiContract).toBe(false);
  });
});