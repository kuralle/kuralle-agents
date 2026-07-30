import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { databaseUrl } from '../src/env.js';
import {
  PRODUCTS_COLLECTION,
  SEARCH_PROJECT,
  createProductMatcher,
  productsCollection,
} from '../src/search.js';
import type { CatalogDocument, Env } from './env.js';

export class CatalogSyncWorkflow extends WorkflowEntrypoint<Env, { documents: CatalogDocument[] }> {
  async run(event: WorkflowEvent<{ documents: CatalogDocument[] }>, step: WorkflowStep) {
    const matcher = createProductMatcher(this.env, databaseUrl(this.env));
    try {
      await step.do('migrate-samesake', () => matcher.migrate());
      await step.do('apply-product-contract', () =>
        matcher.apply(SEARCH_PROJECT, { entities: [], collections: [productsCollection] }),
      );
      await step.do('upsert-catalog-documents', () =>
        matcher.pushDocuments(SEARCH_PROJECT, PRODUCTS_COLLECTION, event.payload.documents),
      );
      return await step.do('build-hybrid-index', () => matcher.index(SEARCH_PROJECT, PRODUCTS_COLLECTION));
    } finally {
      await matcher.close();
    }
  }
}
