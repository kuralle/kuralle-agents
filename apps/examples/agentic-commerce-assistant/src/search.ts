import { Channels, collection, f, gates } from '@samesake/core';
import { createMatcher, type Matcher } from '@samesake/server';
import type { Product, ProductCatalog } from '@kuralle-agents/commerce';
import type { CommerceEnv } from './env.js';
import { embedThroughGateway } from './gateway.js';

export const SEARCH_PROJECT = 'kuralle-commerce';
export const PRODUCTS_COLLECTION = 'products';

export const productsCollection = collection(PRODUCTS_COLLECTION, {
  fields: {
    title: f.text({ searchable: true }),
    description: f.text({ searchable: true }),
    brand: f.text({ searchable: true, filterable: true, facet: true }),
    category: f.text({ searchable: true, filterable: true, facet: true }),
    price: f.number({ filterable: true, facet: 'range', budget: true }),
    currency: f.text({ filterable: true }),
    available: f.boolean({ filterable: true }),
    stock: f.number({ filterable: true }),
    image_url: f.text(),
    product_url: f.text(),
    inventory_checked_at: f.text(),
    price_updated_at: f.text(),
  },
  embeddings: {
    doc: { model: 'text-embedding-3-small', dim: 1536 },
  },
  indexing: {
    surfaces: {
      semantic: {
        kind: 'dense',
        embedding: 'doc',
        build: ({ data }) =>
          [data.title, data.description, data.brand, data.category].filter(Boolean).join(' '),
      },
      lexical: {
        kind: 'fts',
        build: ({ data }) => [data.title, data.description, data.brand].filter(Boolean).join(' '),
      },
    },
    gate: gates.always,
  },
  search: {
    channels: [
      Channels.fts({ fields: ['title', 'description', 'brand', 'category'], weight: 1 }),
      Channels.cosine({ embedding: 'doc', weight: 1 }),
    ],
    combiner: 'rrf',
  },
});

export interface ProductSearchRequest {
  intent: string;
  maxPrice?: number;
  currency?: string;
  inStock?: boolean;
  brand?: string;
  category?: string;
  strict?: boolean;
  explain?: boolean;
  limit?: number;
}

export interface ProductRetrieval {
  find(request: ProductSearchRequest): ReturnType<Matcher['findProducts']>;
  getIndexed(productId: string): Promise<Product | null>;
}

export function createProductMatcher(env: CommerceEnv, connectionString: string): Matcher {
  return createMatcher({
    databaseUrl: connectionString,
    apiKey: env.SAMESAKE_API_KEY,
    schema: 'samesake',
    projectPrefix: 'samesake_project_',
    migrate: 'lazy',
    embed: async ({ text, dim }) => {
      if (!text) throw new Error('This catalog supports text embeddings only');
      return embedThroughGateway(env, text, dim);
    },
  });
}

export function createProductRetrieval(matcher: Matcher): ProductRetrieval {
  return {
    find(request) {
      const constraints: Record<string, unknown> = {};
      if (request.maxPrice != null) constraints.maxPrice = request.maxPrice;
      if (request.currency) constraints.currency = request.currency;
      if (request.inStock != null) constraints.inStock = request.inStock;
      if (request.brand) constraints.brand = request.brand;
      if (request.category) constraints.category = request.category;
      return matcher.findProducts(SEARCH_PROJECT, PRODUCTS_COLLECTION, {
        intent: request.intent,
        constraints,
        constraintMode: request.strict ? 'strict' : 'best_effort',
        explain: request.explain ?? true,
        limit: request.limit ?? 8,
      });
    },
    async getIndexed(productId) {
      const document = await matcher.getDocument(SEARCH_PROJECT, PRODUCTS_COLLECTION, productId);
      if (!document) return null;
      const data = document.data as Record<string, unknown>;
      const amount = Number(data.price);
      return {
        id: productId,
        title: String(data.title ?? productId),
        description: data.description == null ? undefined : String(data.description),
        price: { amount, currency: String(data.currency ?? 'USD') },
        stock: typeof data.stock === 'number' ? data.stock : undefined,
        imageUrl: data.image_url == null ? undefined : String(data.image_url),
      };
    },
  };
}

/** Search comes from Samesake; authoritative line data comes from Porulle. */
export function createRetrievalLedCatalog(
  retrieval: ProductRetrieval,
  authoritativeGet: (id: string) => Promise<Product | null>,
): ProductCatalog {
  return {
    async search(query) {
      const result = await retrieval.find({ intent: query, inStock: true, explain: true });
      return result.products.map((candidate) => ({
        id: candidate.id,
        title: candidate.title ?? candidate.id,
        description: candidate.data.description == null ? undefined : String(candidate.data.description),
        price: {
          amount: candidate.price?.amount ?? Number(candidate.data.price ?? 0),
          currency: candidate.price?.currency ?? String(candidate.data.currency ?? 'USD'),
        },
        stock: typeof candidate.data.stock === 'number' ? candidate.data.stock : undefined,
        imageUrl: candidate.imageUrl,
      }));
    },
    get: authoritativeGet,
  };
}
