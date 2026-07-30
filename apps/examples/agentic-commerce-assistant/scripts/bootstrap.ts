import 'dotenv/config';
import type { CommerceEnv } from '../src/env.js';
import { requireEnv } from '../src/env.js';
import { createProductMatcher, PRODUCTS_COLLECTION, SEARCH_PROJECT, productsCollection } from '../src/search.js';

const env = process.env as unknown as CommerceEnv & { DATABASE_URL: string };
requireEnv(env);
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const response = await fetch(`${env.PORULLE_URL.replace(/\/+$/, '')}/agent/catalog/export`, {
  headers: { authorization: `Bearer ${env.PORULLE_STOREFRONT_KEY}` },
});
if (!response.ok) throw new Error(`Porulle catalog export failed (${response.status})`);
const body = (await response.json()) as { data: Array<{ id: string; data: Record<string, unknown> }> };

const matcher = createProductMatcher(env, env.DATABASE_URL);
try {
  await matcher.migrate();
  await matcher.apply(SEARCH_PROJECT, { entities: [], collections: [productsCollection] });
  await matcher.pushDocuments(SEARCH_PROJECT, PRODUCTS_COLLECTION, body.data);
  const indexed = await matcher.index(SEARCH_PROJECT, PRODUCTS_COLLECTION);
  console.log(JSON.stringify({ documents: body.data.length, indexed }));
} finally {
  await matcher.close();
}
