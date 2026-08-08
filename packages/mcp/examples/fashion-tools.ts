import { z } from 'zod';

import type { ExampleTool } from './_server.js';

/** Synthetic Loom & Field catalogue — invented products, sizes, and colours only. */
const PRODUCTS: Array<{
  sku: string;
  name: string;
  category: string;
  colours: string[];
  sizes: string[];
  price: number;
  stockBySize: Record<string, number>;
}> = [
  {
    sku: 'lf-wool-coat-01',
    name: 'Harbor Wool Coat',
    category: 'outerwear',
    colours: ['slate', 'fog'],
    sizes: ['xs', 's', 'm', 'l', 'xl'],
    price: 248,
    stockBySize: { xs: 2, s: 5, m: 8, l: 4, xl: 1 },
  },
  {
    sku: 'lf-linen-shirt-02',
    name: 'Meadow Linen Shirt',
    category: 'shirts',
    colours: ['ivory', 'sea-glass'],
    sizes: ['xs', 's', 'm', 'l', 'xl'],
    price: 98,
    stockBySize: { xs: 6, s: 10, m: 12, l: 9, xl: 3 },
  },
  {
    sku: 'lf-trouser-03',
    name: 'Canal Wide Trouser',
    category: 'trousers',
    colours: ['charcoal', 'sand'],
    sizes: ['28', '30', '32', '34', '36'],
    price: 128,
    stockBySize: { '28': 4, '30': 7, '32': 6, '34': 5, '36': 2 },
  },
  {
    sku: 'lf-knit-04',
    name: 'Drift Merino Crew',
    category: 'knitwear',
    colours: ['heather', 'pine'],
    sizes: ['xs', 's', 'm', 'l', 'xl'],
    price: 118,
    stockBySize: { xs: 3, s: 8, m: 11, l: 7, xl: 2 },
  },
  {
    sku: 'lf-dress-05',
    name: 'Willow Wrap Dress',
    category: 'dresses',
    colours: ['mulberry', 'ink'],
    sizes: ['xs', 's', 'm', 'l'],
    price: 168,
    stockBySize: { xs: 2, s: 4, m: 6, l: 3 },
  },
];

const SIZE_CHARTS: Record<string, Record<string, { chest: string; waist: string; hip: string }>> = {
  tops: {
    xs: { chest: '32-33 in', waist: '24-25 in', hip: '34-35 in' },
    s: { chest: '34-35 in', waist: '26-27 in', hip: '36-37 in' },
    m: { chest: '36-37 in', waist: '28-29 in', hip: '38-39 in' },
    l: { chest: '38-40 in', waist: '30-32 in', hip: '40-42 in' },
    xl: { chest: '41-43 in', waist: '33-35 in', hip: '43-45 in' },
  },
  trousers: {
    '28': { chest: '—', waist: '28 in', hip: '36 in' },
    '30': { chest: '—', waist: '30 in', hip: '38 in' },
    '32': { chest: '—', waist: '32 in', hip: '40 in' },
    '34': { chest: '—', waist: '34 in', hip: '42 in' },
    '36': { chest: '—', waist: '36 in', hip: '44 in' },
  },
};

const CART: Array<{ sku: string; size: string; colour: string; quantity: number }> = [];
const WISHLIST: string[] = [];
const ORDERS: Record<string, { status: string; items: Array<{ sku: string; size: string }> }> = {
  'ord-7001': {
    status: 'shipped',
    items: [{ sku: 'lf-linen-shirt-02', size: 'm' }],
  },
  'ord-7002': {
    status: 'processing',
    items: [{ sku: 'lf-wool-coat-01', size: 'l' }],
  },
};

function findProduct(sku: string) {
  return PRODUCTS.find((p) => p.sku === sku);
}

export function fashionTools(): ExampleTool[] {
  return [
    {
      name: 'search_products',
      description: 'Search the Loom & Field catalogue by keyword in product name or category.',
      inputSchema: z.object({
        query: z.string().describe('Search term, e.g. wool or shirt'),
      }),
      handler: (args) => {
        const query = String(args.query ?? '').toLowerCase();
        const matches = PRODUCTS.filter(
          (p) => p.name.toLowerCase().includes(query) || p.category.includes(query),
        );
        return { brand: 'Loom & Field', results: matches.map(({ stockBySize: _, ...rest }) => rest) };
      },
    },
    {
      name: 'list_categories',
      description: 'List product categories available at Loom & Field.',
      inputSchema: z.object({}),
      handler: () => ({
        brand: 'Loom & Field',
        categories: [...new Set(PRODUCTS.map((p) => p.category))].sort(),
      }),
    },
    {
      name: 'get_product_details',
      description: 'Fetch full details for one Loom & Field sku including available sizes and colours.',
      inputSchema: z.object({
        sku: z.string().describe('Product sku, e.g. lf-wool-coat-01'),
      }),
      handler: (args) => {
        const product = findProduct(String(args.sku ?? ''));
        if (!product) {
          throw new Error(`Unknown Loom & Field sku: ${args.sku}`);
        }
        return { brand: 'Loom & Field', product };
      },
    },
    {
      name: 'filter_by_size',
      description: 'Return Loom & Field products available in a given size.',
      inputSchema: z.object({
        size: z.string().describe('Size label, e.g. m or 32'),
      }),
      handler: (args) => {
        const size = String(args.size ?? '').toLowerCase();
        const matches = PRODUCTS.filter((p) => p.sizes.includes(size) && (p.stockBySize[size] ?? 0) > 0);
        return { brand: 'Loom & Field', size, results: matches.map((p) => p.sku) };
      },
    },
    {
      name: 'filter_by_colour',
      description: 'Return Loom & Field products available in a given colour.',
      inputSchema: z.object({
        colour: z.string().describe('Colour name, e.g. slate or ivory'),
      }),
      handler: (args) => {
        const colour = String(args.colour ?? '').toLowerCase();
        const matches = PRODUCTS.filter((p) => p.colours.includes(colour));
        return { brand: 'Loom & Field', colour, results: matches.map((p) => p.sku) };
      },
    },
    {
      name: 'check_stock',
      description: 'Check on-hand quantity for a Loom & Field sku and size.',
      inputSchema: z.object({
        sku: z.string(),
        size: z.string(),
      }),
      handler: (args) => {
        const product = findProduct(String(args.sku ?? ''));
        const size = String(args.size ?? '').toLowerCase();
        if (!product) {
          throw new Error(`Unknown sku: ${args.sku}`);
        }
        return {
          brand: 'Loom & Field',
          sku: product.sku,
          size,
          quantity: product.stockBySize[size] ?? 0,
        };
      },
    },
    {
      name: 'lookup_size_chart',
      description: 'Return Loom & Field body measurements for a category and size.',
      inputSchema: z.object({
        category: z.enum(['tops', 'trousers']).describe('Size chart family'),
        size: z.string().describe('Size label to look up'),
      }),
      handler: (args) => {
        const category = String(args.category ?? '') as 'tops' | 'trousers';
        const size = String(args.size ?? '').toLowerCase();
        const chart = SIZE_CHARTS[category]?.[size];
        if (!chart) {
          throw new Error(`No size chart entry for ${category}/${size}`);
        }
        return { brand: 'Loom & Field', category, size, measurements: chart };
      },
    },
    {
      name: 'add_to_cart',
      description: 'Add a Loom & Field item to the session cart.',
      inputSchema: z.object({
        sku: z.string(),
        size: z.string(),
        colour: z.string(),
        quantity: z.number().int().positive().default(1),
      }),
      handler: (args) => {
        const sku = String(args.sku ?? '');
        const product = findProduct(sku);
        if (!product) {
          throw new Error(`Unknown sku: ${sku}`);
        }
        const line = {
          sku,
          size: String(args.size ?? '').toLowerCase(),
          colour: String(args.colour ?? '').toLowerCase(),
          quantity: typeof args.quantity === 'number' ? args.quantity : 1,
        };
        CART.push(line);
        return { brand: 'Loom & Field', cartSize: CART.length, added: line };
      },
    },
    {
      name: 'remove_from_cart',
      description: 'Remove one line from the Loom & Field session cart by index.',
      inputSchema: z.object({
        index: z.number().int().nonnegative().describe('Zero-based cart line index'),
      }),
      handler: (args) => {
        const index = Number(args.index);
        if (index < 0 || index >= CART.length) {
          throw new Error(`Cart index out of range: ${index}`);
        }
        const removed = CART.splice(index, 1)[0];
        return { brand: 'Loom & Field', removed, cartSize: CART.length };
      },
    },
    {
      name: 'view_cart',
      description: 'Return the current Loom & Field session cart contents.',
      inputSchema: z.object({}),
      handler: () => ({ brand: 'Loom & Field', items: [...CART] }),
    },
    {
      name: 'add_to_wishlist',
      description: 'Save a Loom & Field sku to the session wishlist.',
      inputSchema: z.object({ sku: z.string() }),
      handler: (args) => {
        const sku = String(args.sku ?? '');
        if (!findProduct(sku)) {
          throw new Error(`Unknown sku: ${sku}`);
        }
        if (!WISHLIST.includes(sku)) {
          WISHLIST.push(sku);
        }
        return { brand: 'Loom & Field', wishlist: [...WISHLIST] };
      },
    },
    {
      name: 'remove_from_wishlist',
      description: 'Remove a sku from the Loom & Field session wishlist.',
      inputSchema: z.object({ sku: z.string() }),
      handler: (args) => {
        const sku = String(args.sku ?? '');
        const index = WISHLIST.indexOf(sku);
        if (index === -1) {
          throw new Error(`Sku not on wishlist: ${sku}`);
        }
        WISHLIST.splice(index, 1);
        return { brand: 'Loom & Field', wishlist: [...WISHLIST] };
      },
    },
    {
      name: 'view_wishlist',
      description: 'Return skus saved on the Loom & Field session wishlist.',
      inputSchema: z.object({}),
      handler: () => ({ brand: 'Loom & Field', wishlist: [...WISHLIST] }),
    },
    {
      name: 'compare_products',
      description: 'Compare two Loom & Field skus side by side.',
      inputSchema: z.object({
        skuA: z.string(),
        skuB: z.string(),
      }),
      handler: (args) => {
        const a = findProduct(String(args.skuA ?? ''));
        const b = findProduct(String(args.skuB ?? ''));
        if (!a || !b) {
          throw new Error('Both skuA and skuB must exist');
        }
        return {
          brand: 'Loom & Field',
          comparison: [
            { sku: a.sku, name: a.name, price: a.price, category: a.category },
            { sku: b.sku, name: b.name, price: b.price, category: b.category },
          ],
        };
      },
    },
    {
      name: 'apply_promo_code',
      description: 'Validate a promotional code for Loom & Field. Returns discount percent if valid.',
      inputSchema: z.object({
        code: z.string().describe('Promo code, e.g. FIELD10'),
      }),
      handler: (args) => {
        const code = String(args.code ?? '').toUpperCase();
        const promos: Record<string, number> = { FIELD10: 10, LOOM15: 15 };
        const discount = promos[code];
        if (!discount) {
          throw new Error(`Invalid promo code: ${code}`);
        }
        return { brand: 'Loom & Field', code, discountPercent: discount };
      },
    },
    {
      name: 'get_shipping_estimate',
      description: 'Estimate shipping days for a Loom & Field order to a US postal prefix.',
      inputSchema: z.object({
        postalPrefix: z.string().describe('First three digits of ZIP, e.g. 941'),
      }),
      handler: (args) => {
        const prefix = String(args.postalPrefix ?? '');
        const days = prefix.startsWith('9') ? 3 : prefix.startsWith('1') ? 5 : 4;
        return { brand: 'Loom & Field', postalPrefix: prefix, estimatedDays: days, carrier: 'Harbor Post' };
      },
    },
    {
      name: 'get_order_status',
      description: 'Look up fulfilment status for a Loom & Field order id.',
      inputSchema: z.object({
        orderId: z.string().describe('Order id, e.g. ord-7001'),
      }),
      handler: (args) => {
        const orderId = String(args.orderId ?? '');
        const order = ORDERS[orderId];
        if (!order) {
          throw new Error(`Unknown order: ${orderId}`);
        }
        return { brand: 'Loom & Field', orderId, ...order };
      },
    },
    {
      name: 'start_return',
      description: 'Open a return request for a Loom & Field order line.',
      inputSchema: z.object({
        orderId: z.string(),
        sku: z.string(),
        reason: z.string().describe('Return reason code or free text'),
      }),
      handler: (args) => {
        const orderId = String(args.orderId ?? '');
        const order = ORDERS[orderId];
        if (!order) {
          throw new Error(`Unknown order: ${orderId}`);
        }
        return {
          brand: 'Loom & Field',
          returnId: 'ret-8801',
          orderId,
          sku: String(args.sku ?? ''),
          reason: String(args.reason ?? ''),
          status: 'awaiting_dropoff',
        };
      },
    },
  ];
}
