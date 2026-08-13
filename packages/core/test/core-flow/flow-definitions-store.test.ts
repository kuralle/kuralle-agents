import { describe, expect, it } from 'bun:test';
import {
  flowDefinitionsStoreConformanceCases,
  sampleFlowDefinition,
} from '../../src/flows/definition/testing.js';
import { flowDigest } from '../../src/flows/definition/digest.js';
import { canonicalJson } from '../../src/flows/definition/canonical.js';
import { MemoryFlowDefinitionsStore } from '../../src/flows/definition/stores/MemoryFlowDefinitionsStore.js';

describe('MemoryFlowDefinitionsStore conformance', () => {
  for (const testCase of flowDefinitionsStoreConformanceCases) {
    it(testCase.name, async () => {
      await testCase.run(new MemoryFlowDefinitionsStore());
    });
  }
});

describe('flowDigest', () => {
  it('hashes canonical JSON and is stable across key order', async () => {
    const left = sampleFlowDefinition({
      inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } },
    });
    const right = sampleFlowDefinition({
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, z: { type: 'string' } } },
    });
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(await flowDigest(left)).toBe(await flowDigest(right));
    expect(JSON.stringify(left)).not.toBe(JSON.stringify(right));
  });
});
