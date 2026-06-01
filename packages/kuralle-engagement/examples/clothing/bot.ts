import type { LanguageModel } from 'ai';
import { z } from 'zod';
import {
  action,
  collect,
  createRuntime,
  decide,
  defineAgent,
  defineFlow,
  defineTool,
  reply,
  type FlowNode,
  type FlowState,
} from '@kuralle-agents/core';
import {
  createMessagingRouter,
  InMemoryWindowStore,
  OutboundPipeline,
  windowGuard,
  type PlatformClient,
} from '@kuralle-agents/messaging';
import type { TemplateInfo, WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import type { InstagramClient } from '@kuralle-agents/messaging-meta/instagram';
import {
  engagement,
  webPolicy,
  whatsappPolicy,
  instagramPolicy,
  withChoices,
  sessionConsentStore,
  createInMemoryBroadcastLedger,
  createBroadcasts,
  type TemplateCatalog,
  type TemplateSelector,
  type BroadcastApi,
} from '@kuralle-agents/engagement';
import type { ConsentStore } from '@kuralle-agents/messaging';

export const CATALOG_PRODUCTS = [
  { id: 'tee', name: 'Cotton Tee', price: 25 },
  { id: 'hoodie', name: 'Zip Hoodie', price: 60 },
  { id: 'jeans', name: 'Slim Jeans', price: 80 },
] as const;

export const SIZE_CHOICES = [
  { id: 's', label: 'S' },
  { id: 'm', label: 'M' },
  { id: 'l', label: 'L' },
  { id: 'xl', label: 'XL' },
] as const;

export const COLOR_CHOICES = [
  { id: 'black', label: 'Black' },
  { id: 'white', label: 'White' },
  { id: 'navy', label: 'Navy' },
] as const;

export type CartLine = {
  productId: string;
  name: string;
  price: number;
  size: string;
  color: string;
};

export const promoDropTemplate: TemplateInfo = {
  id: 'tpl-promo-drop',
  name: 'promo_drop',
  language: 'en_US',
  status: 'APPROVED',
  category: 'MARKETING',
  components: [
    {
      type: 'BODY',
      text: 'New drop! 20% off this weekend — reply SHOP to browse.',
    },
  ],
  quality: 'GREEN',
};

export const clothingTemplateCatalog: TemplateCatalog = {
  async approved() {
    return [
      {
        name: 'promo_drop',
        language: 'en_US',
        category: 'marketing',
        status: 'APPROVED',
        quality: 'GREEN',
        params: [],
      },
    ];
  },
  validateParams(name) {
    if (name !== 'promo_drop') {
      return { ok: false, errors: [`unknown template ${name}`] };
    }
    return { ok: true };
  },
};

export function mockWhatsAppTemplatesClient(
  templates: TemplateInfo[] = [promoDropTemplate],
): WhatsAppClient {
  return {
    templates: { list: async () => templates },
  } as unknown as WhatsAppClient;
}

export function mockInstagramClient(): InstagramClient {
  return {} as unknown as InstagramClient;
}

export function defaultClothingSelector(): TemplateSelector {
  return {
    async select() {
      return { name: 'promo_drop', language: 'en_US', params: {} };
    },
  };
}

const addressSchema = z.object({
  name: z.string(),
  street: z.string(),
  city: z.string(),
  zip: z.string(),
});

const choiceSchema = z.object({ choice: z.string() });

function productById(id: string) {
  return CATALOG_PRODUCTS.find((p) => p.id === id);
}

function cartTotal(cart: CartLine[]): number {
  return cart.reduce((sum, line) => sum + line.price, 0);
}

function ensureCart(state: FlowState): CartLine[] {
  if (!Array.isArray(state.cart)) {
    state.cart = [];
  }
  return state.cart as CartLine[];
}

const catalogTool = defineTool({
  name: 'catalog',
  description: 'Return the clothing catalog.',
  input: z.object({}),
  execute: async () => ({ products: [...CATALOG_PRODUCTS] }),
});

const addToCartTool = defineTool({
  name: 'addToCart',
  description: 'Append a configured line item to the cart.',
  input: z.object({
    productId: z.string(),
    size: z.string(),
    color: z.string(),
  }),
  execute: async ({ productId, size, color }) => {
    const product = productById(productId);
    if (!product) {
      return { added: false as const, reason: 'unknown product' };
    }
    return {
      added: true as const,
      line: {
        productId,
        name: product.name,
        price: product.price,
        size,
        color,
      } satisfies CartLine,
    };
  },
});

const removeLastTool = defineTool({
  name: 'removeLast',
  description: 'Remove the last cart line.',
  input: z.object({}),
  execute: async () => ({ removed: true }),
});

export const chargeTool = defineTool({
  name: 'charge',
  description: 'Charge the cart total.',
  input: z.object({ total: z.number() }),
  execute: async ({ total }) => ({
    charged: true,
    total,
    orderNumber: `ORD-${Date.now().toString(36).toUpperCase()}`,
  }),
});

export function buildClothingBot(model: LanguageModel) {
  const orderConfirm = reply({
    id: 'orderConfirm',
    instructions: ({ state }) => {
      const cart = (state.cart ?? []) as CartLine[];
      const lines = cart
        .map((l) => `${l.name} (${l.size}/${l.color}) $${l.price}`)
        .join('; ');
      const addr = state as FlowState & {
        name?: string;
        street?: string;
        city?: string;
        zip?: string;
      };
      return [
        `Order ${state.orderNumber} confirmed (demo).`,
        `Items: ${lines}.`,
        `Total: $${state.orderTotal ?? cartTotal(cart)}.`,
        `Ship to: ${addr.name}, ${addr.street}, ${addr.city} ${addr.zip}.`,
        'Reply anytime to shop again. Text alerts to opt in for weekend drop notifications.',
      ].join(' ');
    },
    next: () => ({ end: 'ordered' }),
  });

  const payment = action({
    id: 'payment',
    run: async (state, ctx) => {
      const cart = ensureCart(state);
      const total = cartTotal(cart);
      const result = (await ctx.tool('charge', { total })) as {
        charged: boolean;
        total: number;
        orderNumber: string;
      };
      state.orderTotal = result.total;
      state.orderNumber = result.orderNumber;
      return orderConfirm;
    },
  });

  const address = collect({
    id: 'address',
    schema: addressSchema,
    required: ['name', 'street', 'city', 'zip'],
    instructions: () =>
      'Ask for full shipping address: name, street, city, and ZIP in one message.',
    onComplete: (data, state) => {
      Object.assign(state, data as Record<string, unknown>);
      const bucket = state.__collect_address;
      if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
        Object.assign(state, bucket as Record<string, unknown>);
      }
      return payment;
    },
  });

  let cartReview: FlowNode;
  let browse: FlowNode;

  const removeLast = action({
    id: 'removeLast',
    run: async (state, ctx) => {
      await ctx.tool('removeLast', {});
      const cart = ensureCart(state);
      if (cart.length > 0) cart.pop();
      return cartReview;
    },
  });

  const addToCart = action({
    id: 'addToCart',
    run: async (state, ctx) => {
      const result = (await ctx.tool('addToCart', {
        productId: String(state.productId),
        size: String(state.size),
        color: String(state.color),
      })) as { added: boolean; line?: CartLine };
      const cart = ensureCart(state);
      if (result.added && result.line) {
        cart.push(result.line);
      }
      return cartReview;
    },
  });

  const pickColor = withChoices(
    decide({
      id: 'pickColor',
      instructions: 'Pick a color.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const color = (sel as { choice: string }).choice;
        if (!color) return 'stay';
        state.color = color;
        return addToCart;
      },
    }),
    [...COLOR_CHOICES],
  );

  const pickSize = withChoices(
    decide({
      id: 'pickSize',
      instructions: 'Pick a size.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const size = (sel as { choice: string }).choice;
        if (!size) return 'stay';
        state.size = size;
        return pickColor;
      },
    }),
    [...SIZE_CHOICES],
  );

  const pickProduct = withChoices(
    decide({
      id: 'pickProduct',
      instructions: 'Pick a product from the catalog.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const productId = (sel as { choice: string }).choice;
        if (!productId) return 'stay';
        state.productId = productId;
        const product = productById(productId);
        if (product) state.productName = product.name;
        return pickSize;
      },
    }),
    CATALOG_PRODUCTS.map((p) => ({ id: p.id, label: p.name })),
  );

  browse = action({
    id: 'browse',
    run: async (state, ctx) => {
      const result = (await ctx.tool('catalog', {})) as {
        products: typeof CATALOG_PRODUCTS;
      };
      state.catalog = result.products;
      return pickProduct;
    },
  });

  cartReview = withChoices(
    decide({
      id: 'cartReview',
      instructions: 'Review cart: checkout, add another item, or remove last item.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const choice = (sel as { choice: string }).choice;
        if (!choice) return 'stay';
        if (choice === 'checkout') return address;
        if (choice === 'more') return state.catalog ? pickProduct : browse;
        if (choice === 'remove') return removeLast;
        return 'stay';
      },
    }),
    [
      { id: 'checkout', label: 'Checkout' },
      { id: 'more', label: 'Add another item' },
      { id: 'remove', label: 'Remove last item' },
    ],
  );

  const shopFlow = defineFlow({
    name: 'shop',
    description:
      'Clothing store: catalog, size/color picks, cart, address extraction, checkout.',
    maxOscillations: 12,
    start: browse,
    nodes: [
      browse,
      pickProduct,
      pickSize,
      pickColor,
      addToCart,
      cartReview,
      removeLast,
      address,
      payment,
      orderConfirm,
    ],
  });

  const agent = defineAgent({
    id: 'acme-threads',
    name: 'Acme Threads',
    instructions:
      'You help customers shop demo apparel. Be concise on messaging channels. Never claim real payment processing.',
    model,
    effectTools: {
      catalog: catalogTool,
      addToCart: addToCartTool,
      removeLast: removeLastTool,
      charge: chargeTool,
    },
    flows: [shopFlow],
  });

  return {
    agent,
    flow: shopFlow,
    browse,
    pickProduct,
    pickSize,
    pickColor,
    addToCart,
    cartReview,
    removeLast,
    address,
    payment,
    orderConfirm,
  };
}

export interface BuildClothingRouterOptions {
  model: LanguageModel;
  platforms?: Record<string, PlatformClient>;
  windowStore?: InMemoryWindowStore;
  selector?: TemplateSelector;
  catalog?: TemplateCatalog;
  whatsappClient?: WhatsAppClient;
  instagramClient?: InstagramClient;
  wabaId?: string;
}

export interface ClothingRouterBundle {
  router: ReturnType<typeof createMessagingRouter>;
  runtime: ReturnType<typeof createRuntime>;
  eng: ReturnType<typeof engagement>;
  windowStore: InMemoryWindowStore;
  consent: ConsentStore;
  broadcasts: BroadcastApi;
}

export function buildClothingRouter(opts: BuildClothingRouterOptions): ClothingRouterBundle {
  const windowStore = opts.windowStore ?? new InMemoryWindowStore();
  const selector = opts.selector ?? defaultClothingSelector();
  const waClient = opts.whatsappClient ?? mockWhatsAppTemplatesClient();
  const igClient = opts.instagramClient ?? mockInstagramClient();

  const { agent } = buildClothingBot(opts.model);
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: opts.model,
  });

  const sessionStore = runtime.getSessionStore();
  const consent = sessionConsentStore(sessionStore, { defaultOptedIn: false });
  const ledger = createInMemoryBroadcastLedger();
  const defaultPlatforms = opts.platforms ?? {};

  const eng = engagement({
    policies: [
      whatsappPolicy({
        client: waClient,
        selector,
        windowStore,
        wabaId: opts.wabaId ?? 'waba-demo',
      }),
      webPolicy(),
      instagramPolicy({ client: igClient, windowStore }),
    ],
    consent,
    windowStore,
    ledger,
  });

  const waPlatform = defaultPlatforms.whatsapp;
  const broadcasts = waPlatform
    ? createBroadcasts({
        pipeline: new OutboundPipeline([...(eng.bridge.outbound ?? []), windowGuard], waPlatform),
        consent,
        ledger,
        platform: 'whatsapp',
      })
    : eng.broadcasts;

  const router = createMessagingRouter({
    runtime,
    platforms: defaultPlatforms,
    ...eng.bridge,
  });

  return {
    router,
    runtime,
    eng,
    windowStore,
    consent,
    broadcasts,
  };
}
