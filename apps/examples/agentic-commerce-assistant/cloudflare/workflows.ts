import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { databaseUrl } from '../src/env.js';
import { createPorulleClient } from '../src/porulle.js';
import {
  PRODUCTS_COLLECTION,
  SEARCH_PROJECT,
  createProductMatcher,
  productsCollection,
} from '../src/search.js';
import type { CatalogDocument, CheckoutQueueMessage, Env } from './env.js';

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

export class CheckoutWorkflow extends WorkflowEntrypoint<Env, Omit<CheckoutQueueMessage, 'kind'>> {
  async run(event: WorkflowEvent<Omit<CheckoutQueueMessage, 'kind'>>, step: WorkflowStep) {
    const client = createPorulleClient({
      baseUrl: this.env.PORULLE_URL,
      apiKey: this.env.PORULLE_STOREFRONT_KEY,
    });
    return step.do(
      'server-priced-porulle-stripe-checkout',
      { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      () => client.checkout({
        items: event.payload.items,
        idempotencyKey: event.payload.contentKey,
        paymentMethodToken: event.payload.paymentMethodToken,
      }),
    );
  }
}
