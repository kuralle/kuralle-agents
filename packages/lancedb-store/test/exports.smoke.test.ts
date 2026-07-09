import { describe, it, expect } from 'bun:test';
import { LanceDBVectorStore } from '../src/LanceDBVectorStore.js';

describe('@kuralle-agents/lancedb-store smoke', () => {
  it('exports LanceDBVectorStore constructor', () => {
    expect(typeof LanceDBVectorStore).toBe('function');
    expect(new LanceDBVectorStore({ uri: ':memory:' })).toBeInstanceOf(LanceDBVectorStore);
  });
});
