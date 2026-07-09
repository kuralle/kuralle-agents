import { describe, it, expect } from 'bun:test';
import { MessagingError } from '@kuralle-agents/messaging';
import type { InboundMessage } from '@kuralle-agents/messaging';
import { WhatsAppClient } from '../src/whatsapp/client.ts';
import {
  parseInboundOrder,
  parseInboundAddress,
  MAX_PRODUCT_LIST_SECTIONS,
  MAX_PRODUCT_LIST_PRODUCTS,
} from '../src/whatsapp/commerce.ts';
import type { WhatsAppClientConfig, ProductSection } from '../src/whatsapp/types.ts';
import type { NormalizedMessage } from '../src/webhook/normalizer.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PHONE_NUMBER_ID = '999888777';

const baseConfig: WhatsAppClientConfig = {
  accessToken: 'fake_access_token',
  appSecret: 'test_secret_for_client',
  phoneNumberId: PHONE_NUMBER_ID,
  verifyToken: 'my_verify_token',
};

/**
 * Test harness that captures Graph API posts (so payload construction can be
 * asserted without HTTP) and exposes the protected `toInboundMessage`.
 */
class WhatsAppCommerceTestHarness extends WhatsAppClient {
  readonly posts: Array<{ endpoint: string; body: Record<string, unknown> }> = [];

  constructor(config: WhatsAppClientConfig) {
    super(config);
    Object.assign(this.graphApi, {
      post: async (endpoint: string, body: unknown) => {
        this.posts.push({ endpoint, body: body as Record<string, unknown> });
        return {
          messaging_product: 'whatsapp',
          contacts: [{ input: 'x', wa_id: 'x' }],
          messages: [{ id: 'wamid.sent001' }],
        };
      },
    });
  }

  convert(msg: NormalizedMessage): InboundMessage {
    return this.toInboundMessage(msg);
  }

  lastInteractive(): Record<string, unknown> {
    const last = this.posts[this.posts.length - 1];
    return last.body.interactive as Record<string, unknown>;
  }
}

function makeSections(sectionCount: number, productsPerSection: number): ProductSection[] {
  return Array.from({ length: sectionCount }, (_, i) => ({
    title: `Section ${i + 1}`,
    productRetailerIds: Array.from(
      { length: productsPerSection },
      (_, j) => `sku-${i + 1}-${j + 1}`,
    ),
  }));
}

function baseNormalized(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'wamid.test',
    from: '5511999999999',
    timestamp: '1700000000',
    type: 'text',
    phoneNumberId: PHONE_NUMBER_ID,
    ...overrides,
  };
}

/** Inbound order built from the Meta docs order-webhook example. */
const docsOrder: NonNullable<NormalizedMessage['order']> = {
  catalog_id: '194836987003835',
  text: 'Love these!',
  product_items: [
    { product_retailer_id: 'di9ozbzfi4', quantity: 2, item_price: 30, currency: 'USD' },
    { product_retailer_id: 'nqryix03ez', quantity: 1, item_price: 25, currency: 'USD' },
  ],
};

// ---------------------------------------------------------------------------
// sendProduct
// ---------------------------------------------------------------------------

describe('WhatsAppClient.sendProduct — payload construction', () => {
  it('builds an interactive product payload with catalog_id and product_retailer_id', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    const result = await harness.sendProduct('5511999999999', {
      catalogId: '194836987003835',
      productRetailerId: 'di9ozbzfi4',
      body: { text: 'Check this out' },
      footer: { text: 'Tap View for details' },
    });

    expect(harness.posts).toHaveLength(1);
    const { endpoint, body } = harness.posts[0];
    expect(endpoint).toBe(`${PHONE_NUMBER_ID}/messages`);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.recipient_type).toBe('individual');
    expect(body.to).toBe('5511999999999');
    expect(body.type).toBe('interactive');
    expect(body.interactive).toEqual({
      type: 'product',
      body: { text: 'Check this out' },
      footer: { text: 'Tap View for details' },
      action: {
        catalog_id: '194836987003835',
        product_retailer_id: 'di9ozbzfi4',
      },
    });
    expect(result.messageId).toBe('wamid.sent001');
    expect(result.threadId).toBe(`whatsapp:${PHONE_NUMBER_ID}:5511999999999`);
  });

  it('omits body and footer when not provided', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await harness.sendProduct('5511999999999', {
      catalogId: 'CATALOG',
      productRetailerId: 'SKU-1',
    });

    const interactive = harness.lastInteractive();
    expect(interactive.body).toBeUndefined();
    expect(interactive.footer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendProductList
// ---------------------------------------------------------------------------

describe('WhatsAppClient.sendProductList — payload construction', () => {
  it('builds an interactive product_list payload with sections and product_items', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await harness.sendProductList('5511999999999', {
      header: { type: 'text', text: 'Our bestsellers' },
      body: { text: 'Pick your favorites' },
      footer: { text: 'Free shipping over $50' },
      catalogId: 'CATALOG_ID',
      sections: [
        { title: 'Cakes', productRetailerIds: ['cake-1', 'cake-2'] },
        { title: 'Cookies', productRetailerIds: ['cookie-1'] },
      ],
    });

    expect(harness.lastInteractive()).toEqual({
      type: 'product_list',
      header: { type: 'text', text: 'Our bestsellers' },
      body: { text: 'Pick your favorites' },
      footer: { text: 'Free shipping over $50' },
      action: {
        catalog_id: 'CATALOG_ID',
        sections: [
          {
            title: 'Cakes',
            product_items: [
              { product_retailer_id: 'cake-1' },
              { product_retailer_id: 'cake-2' },
            ],
          },
          {
            title: 'Cookies',
            product_items: [{ product_retailer_id: 'cookie-1' }],
          },
        ],
      },
    });
  });

  it('allows the documented maximums (10 sections, 30 products)', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await harness.sendProductList('5511999999999', {
      header: { type: 'text', text: 'Catalog' },
      body: { text: 'Browse' },
      catalogId: 'CATALOG_ID',
      sections: makeSections(MAX_PRODUCT_LIST_SECTIONS, 3),
    });

    expect(harness.posts).toHaveLength(1);
  });
});

describe('WhatsAppClient.sendProductList — validation', () => {
  function expectInvalidProductList(promise: Promise<unknown>) {
    return promise.then(
      () => {
        throw new Error('expected sendProductList to throw');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(MessagingError);
        expect((error as MessagingError).code).toBe('INVALID_PRODUCT_LIST');
        expect((error as MessagingError).platform).toBe('whatsapp');
      },
    );
  }

  it('rejects more than 10 sections without sending', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await expectInvalidProductList(
      harness.sendProductList('5511999999999', {
        header: { type: 'text', text: 'Catalog' },
        body: { text: 'Browse' },
        catalogId: 'CATALOG_ID',
        sections: makeSections(MAX_PRODUCT_LIST_SECTIONS + 1, 1),
      }),
    );
    expect(harness.posts).toHaveLength(0);
  });

  it('rejects more than 30 products across sections without sending', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await expectInvalidProductList(
      harness.sendProductList('5511999999999', {
        header: { type: 'text', text: 'Catalog' },
        body: { text: 'Browse' },
        catalogId: 'CATALOG_ID',
        // 8 sections x 4 products = 32 > 30
        sections: makeSections(8, 4),
      }),
    );
    expect(harness.posts).toHaveLength(0);
  });

  it('rejects empty sections array', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await expectInvalidProductList(
      harness.sendProductList('5511999999999', {
        header: { type: 'text', text: 'Catalog' },
        body: { text: 'Browse' },
        catalogId: 'CATALOG_ID',
        sections: [],
      }),
    );
  });

  it('rejects a section with no products', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await expectInvalidProductList(
      harness.sendProductList('5511999999999', {
        header: { type: 'text', text: 'Catalog' },
        body: { text: 'Browse' },
        catalogId: 'CATALOG_ID',
        sections: [{ title: 'Empty', productRetailerIds: [] }],
      }),
    );
  });

  it('total-product limit matches the documented value', () => {
    expect(MAX_PRODUCT_LIST_PRODUCTS).toBe(30);
    expect(MAX_PRODUCT_LIST_SECTIONS).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// sendCatalog
// ---------------------------------------------------------------------------

describe('WhatsAppClient.sendCatalog — payload construction', () => {
  it('builds an interactive catalog_message payload with thumbnail parameters', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await harness.sendCatalog('5511999999999', {
      body: { text: 'Visit our catalog and add items to purchase.' },
      footer: { text: 'Best grocery deals on WhatsApp!' },
      thumbnailProductRetailerId: '2lc20305pt',
    });

    expect(harness.lastInteractive()).toEqual({
      type: 'catalog_message',
      body: { text: 'Visit our catalog and add items to purchase.' },
      footer: { text: 'Best grocery deals on WhatsApp!' },
      action: {
        name: 'catalog_message',
        parameters: { thumbnail_product_retailer_id: '2lc20305pt' },
      },
    });
  });

  it('omits action.parameters when no thumbnail is provided', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await harness.sendCatalog('5511999999999', {
      body: { text: 'Browse our catalog' },
    });

    const action = harness.lastInteractive().action as Record<string, unknown>;
    expect(action.name).toBe('catalog_message');
    expect(action.parameters).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sendAddressRequest
// ---------------------------------------------------------------------------

describe('WhatsAppClient.sendAddressRequest — payload construction', () => {
  it('builds an interactive address_message payload with country', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await harness.sendAddressRequest('919999999999', {
      body: { text: 'Tell us what address you’d like this order delivered to.' },
      country: 'IN',
    });

    const interactive = harness.lastInteractive();
    expect(interactive.type).toBe('address_message');
    expect(interactive.body).toEqual({
      text: 'Tell us what address you’d like this order delivered to.',
    });
    expect(interactive.action).toEqual({
      name: 'address_message',
      parameters: {
        country: 'IN',
        values: undefined,
        saved_addresses: undefined,
        validation_errors: undefined,
      },
    });
  });

  it('passes values, saved addresses, and validation errors through', async () => {
    const harness = new WhatsAppCommerceTestHarness(baseConfig);
    await harness.sendAddressRequest('919999999999', {
      body: { text: 'Confirm your address' },
      country: 'IN',
      values: { name: 'CUSTOMER_NAME', phone_number: '+919999999999' },
      savedAddresses: [
        {
          id: 'address1',
          value: { in_pin_code: '400063', city: 'Mumbai', landmark_area: 'Goregaon' },
        },
      ],
      validationErrors: { in_pin_code: 'We could not locate this pin code.' },
    });

    const action = harness.lastInteractive().action as {
      name: string;
      parameters: Record<string, unknown>;
    };
    expect(action.parameters.country).toBe('IN');
    expect(action.parameters.values).toEqual({
      name: 'CUSTOMER_NAME',
      phone_number: '+919999999999',
    });
    expect(action.parameters.saved_addresses).toEqual([
      {
        id: 'address1',
        value: { in_pin_code: '400063', city: 'Mumbai', landmark_area: 'Goregaon' },
      },
    ]);
    expect(action.parameters.validation_errors).toEqual({
      in_pin_code: 'We could not locate this pin code.',
    });
  });
});

// ---------------------------------------------------------------------------
// Inbound order — toInboundMessage + parseInboundOrder
// ---------------------------------------------------------------------------

describe('inbound order — toInboundMessage and parseInboundOrder', () => {
  const harness = new WhatsAppCommerceTestHarness(baseConfig);

  it('surfaces the typed order via raw and parseInboundOrder', () => {
    const inbound = harness.convert(
      baseNormalized({ type: 'order', order: docsOrder }),
    );

    const order = parseInboundOrder(inbound);
    expect(order).toBeDefined();
    expect(order!.catalog_id).toBe('194836987003835');
    expect(order!.text).toBe('Love these!');
    expect(order!.product_items).toHaveLength(2);
    expect(order!.product_items[0]).toEqual({
      product_retailer_id: 'di9ozbzfi4',
      quantity: 2,
      item_price: 30,
      currency: 'USD',
    });
  });

  it('falls back to the order text for the inbound message text', () => {
    const inbound = harness.convert(
      baseNormalized({ type: 'order', order: docsOrder }),
    );
    expect(inbound.text).toBe('Love these!');
  });

  it('returns undefined for non-order messages', () => {
    const inbound = harness.convert(
      baseNormalized({ text: { body: 'Hello' } }),
    );
    expect(parseInboundOrder(inbound)).toBeUndefined();
  });

  it('returns undefined when raw is not a normalized message', () => {
    const inbound = harness.convert(baseNormalized({ text: { body: 'Hi' } }));
    expect(parseInboundOrder({ ...inbound, raw: undefined })).toBeUndefined();
    expect(parseInboundOrder({ ...inbound, raw: 'not-an-object' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inbound address response — parseInboundAddress
// ---------------------------------------------------------------------------

describe('inbound address response — parseInboundAddress', () => {
  const harness = new WhatsAppCommerceTestHarness(baseConfig);

  /** response_json from the Meta docs address-message reply example. */
  const docsResponseJson = JSON.stringify({
    saved_address_id: 'address1',
    values: {
      in_pin_code: '400063',
      building_name: '',
      landmark_area: 'Goregaon',
      address: 'Wing A, Cello Triumph, IB Patel Rd',
      city: 'Mumbai',
      name: 'CUSTOMER_NAME',
      phone_number: '+91xxxxxxxxxx',
      floor_number: '8',
    },
  });

  function addressReply(responseJson: string): NormalizedMessage {
    return baseNormalized({
      type: 'interactive',
      interactive: {
        type: 'nfm_reply',
        nfm_reply: {
          name: 'address_message',
          response_json: responseJson,
          body: 'CUSTOMER_NAME\n +91xxxxxxxxxx\n 400063, Goregaon, Mumbai',
        },
      },
    });
  }

  it('parses the docs address submission into a typed address', () => {
    const inbound = harness.convert(addressReply(docsResponseJson));
    const parsed = parseInboundAddress(inbound);

    expect(parsed).toBeDefined();
    expect(parsed!.saved_address_id).toBe('address1');
    expect(parsed!.values.in_pin_code).toBe('400063');
    expect(parsed!.values.city).toBe('Mumbai');
    expect(parsed!.values.name).toBe('CUSTOMER_NAME');
  });

  it('also exposes the submission via interactive.formResponse', () => {
    const inbound = harness.convert(addressReply(docsResponseJson));
    expect(inbound.interactive?.formResponse).toEqual(JSON.parse(docsResponseJson));
  });

  it('returns undefined for nfm replies that are not address messages', () => {
    const inbound = harness.convert(
      baseNormalized({
        type: 'interactive',
        interactive: {
          type: 'nfm_reply',
          nfm_reply: { name: 'flow', response_json: '{"order_id":"ord-1"}' },
        },
      }),
    );
    expect(parseInboundAddress(inbound)).toBeUndefined();
  });

  it('returns undefined for malformed response_json without throwing', () => {
    const inbound = harness.convert(addressReply('{not-json'));
    expect(parseInboundAddress(inbound)).toBeUndefined();
  });

  it('returns undefined when values is missing', () => {
    const inbound = harness.convert(addressReply('{"saved_address_id":"address1"}'));
    expect(parseInboundAddress(inbound)).toBeUndefined();
  });
});
