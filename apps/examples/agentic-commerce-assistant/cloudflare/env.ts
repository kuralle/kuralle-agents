import type { CommerceEnv } from '../src/env.js';

export interface CatalogDocument {
  id: string;
  data: Record<string, unknown>;
}

export interface CatalogQueueMessage {
  kind: 'catalog.upsert';
  documents: CatalogDocument[];
}

export interface CheckoutQueueMessage {
  kind: 'checkout.requested';
  contentKey: string;
  items: Array<{ productId: string; quantity: number }>;
  paymentMethodToken: string;
}

export type CommerceQueueMessage = CatalogQueueMessage | CheckoutQueueMessage;

export interface Env extends CommerceEnv {
  CommerceAgent: DurableObjectNamespace<import('./agent.js').CommerceAgent>;
  HYPERDRIVE?: Hyperdrive;
  ASSETS: Fetcher;
  COMMERCE_EVENTS: Queue<CommerceQueueMessage>;
  CATALOG_SYNC_WORKFLOW: Workflow;
  CHECKOUT_WORKFLOW: Workflow;
  ADMIN_TOKEN: string;
}
