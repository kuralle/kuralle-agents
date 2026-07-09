import { runVectorStoreContract } from '../../src/vectorStores/testing.js';
import { InMemoryVectorStore } from '../../src/vectorStores/InMemoryVectorStore.js';

runVectorStoreContract(() => new InMemoryVectorStore());
