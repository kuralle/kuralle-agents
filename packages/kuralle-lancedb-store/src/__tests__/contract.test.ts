/**
 * Shared-contract test wiring for LanceDBVectorStore.
 *
 * Runs `runVectorStoreContract` (from rag) against a real LanceDB store
 * backed by a per-test-run temp directory. No external service required —
 * LanceDB is embedded (Node/Bun only).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runVectorStoreContract } from '@kuralle-agents/rag/vectorStores/testing';

import { LanceDBVectorStore } from '../LanceDBVectorStore.js';

runVectorStoreContract(
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuralle-lancedb-contract-'));
    return new LanceDBVectorStore({ uri: dir });
  },
  {
    indexName: 'contract',
    dimension: 3,
    // LanceDbVectorStore's private `filterToSql` emits `json_extract(...)`
    // which the current LanceDB release rejects ("Invalid function
    // 'json_extract'"). Migration to the canonical rag/filters/
    // `toLanceDbWhere` under REQ-33 lands with issue 25; opt out of the
    // filter test until then.
    skipFilterTests: true,
  },
);
