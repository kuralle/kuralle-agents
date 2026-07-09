import type { VectorFilter } from '../types.js';
import { UnsupportedFilterOperatorError } from './errors.js';

/**
 * Translate Kuralle's MongoDB-style `VectorFilter` into the flat object shape
 * Cloudflare Vectorize accepts. Vectorize filters are field-level only.
 *
 * Unsupported top-level logical operators (`$and`, `$or`, `$not`) throw
 * `UnsupportedFilterOperatorError` — previously silently warned + dropped.
 */
export function toCloudflareFilter(filter?: VectorFilter): Record<string, unknown> {
  if (!filter) return {};

  if ('$and' in filter) {
    throw new UnsupportedFilterOperatorError({
      backend: 'cloudflare',
      operator: '$and',
      reason: 'Vectorize only supports flat field-level filters',
    });
  }
  if ('$or' in filter) {
    throw new UnsupportedFilterOperatorError({
      backend: 'cloudflare',
      operator: '$or',
      reason: 'Vectorize only supports flat field-level filters',
    });
  }
  if ('$not' in filter) {
    throw new UnsupportedFilterOperatorError({
      backend: 'cloudflare',
      operator: '$not',
      reason: 'Vectorize only supports flat field-level filters',
    });
  }

  const flat: Record<string, unknown> = {};
  for (const [field, condition] of Object.entries(filter)) {
    if (typeof condition !== 'object' || condition === null) {
      flat[field] = condition;
    } else {
      flat[field] = condition;
    }
  }
  return flat;
}
