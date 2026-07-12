import { describe } from 'bun:test';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { runSessionStoreCasContract } from '../../src/session/testing.js';

describe('MemoryStore CAS (C2)', () => {
  runSessionStoreCasContract(() => new MemoryStore());
});