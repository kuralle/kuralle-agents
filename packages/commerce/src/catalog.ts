import type { Product, ProductCatalog } from './types.js';

/** In-memory catalog for dev/tests. Production: implement `ProductCatalog` over your backend. */
export function createInMemoryCatalog(products: Product[]): ProductCatalog {
  const byId = new Map(products.map((product) => [product.id, product]));
  return {
    async get(productId) {
      return byId.get(productId) ?? null;
    },
    async search(query, opts) {
      const limit = opts?.limit ?? 10;
      const tokens = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 1);
      const scored = products
        .map((product) => {
          const haystack = `${product.title} ${product.description ?? ''}`.toLowerCase();
          const hits = tokens.filter((token) => haystack.includes(token)).length;
          return { product, hits };
        })
        .filter((entry) => entry.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      return scored.slice(0, limit).map((entry) => entry.product);
    },
  };
}
