import { describe, expect, it } from 'bun:test';
import { parseOkfConcept, listOkfConcepts, okfBundleToFs } from '../src/index.js';

const ORDERS = `---
type: BigQuery Table
title: Orders
description: One row per completed order.
tags: [sales, revenue]
timestamp: 2026-05-28T00:00:00Z
---

# Schema
FK to [customers](/tables/customers.md).
Part of the [sales dataset](/datasets/sales.md).
`;

describe('test:okf', () => {
  it('parses a concept: required type, recommended fields, and the link graph', () => {
    const c = parseOkfConcept(ORDERS, 'tables/orders');
    expect(c.type).toBe('BigQuery Table');
    expect(c.title).toBe('Orders');
    expect(c.tags).toEqual(['sales', 'revenue']);
    expect(c.timestamp).toBe('2026-05-28T00:00:00Z');
    expect(c.links.sort()).toEqual(['datasets/sales', 'tables/customers']);
    expect(c.body).toContain('# Schema');
  });

  it('throws only when the required type field is missing (spec §9)', () => {
    expect(() => parseOkfConcept('---\ntitle: X\n---\nbody', 'x')).toThrow(/type/);
    expect(() => parseOkfConcept('no frontmatter', 'x')).toThrow(/frontmatter/);
  });

  it('lists concepts across a bundle, skips reserved index.md/log.md, permissive on bad docs', async () => {
    const fs = okfBundleToFs({
      '/index.md': '# Bundle\n* [Orders](/tables/orders.md)',
      '/log.md': '# Log\n## 2026-05-28\n* Init',
      '/tables/orders.md': ORDERS,
      '/tables/customers.md': '---\ntype: BigQuery Table\ntitle: Customers\n---\n# Schema',
      '/tables/broken.md': 'no frontmatter here', // §9: skipped, not fatal
    });
    const concepts = await listOkfConcepts(fs);
    expect(concepts.map((c) => c.id).sort()).toEqual(['tables/customers', 'tables/orders']);
    const orders = concepts.find((c) => c.id === 'tables/orders')!;
    expect(orders.type).toBe('BigQuery Table');
    expect(orders.links).toContain('tables/customers');
  });
});
