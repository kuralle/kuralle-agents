import { describe, it, expect } from 'bun:test';
import { normalizeWebhook } from '../src/webhook/normalizer.ts';

// ---------------------------------------------------------------------------
// WhatsApp webhook payloads
// ---------------------------------------------------------------------------

describe('normalizeWebhook — WhatsApp', () => {
  it('normalizes a text message', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456', display_phone_number: '+1234567890' },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '5511999999999' }],
                messages: [
                  {
                    id: 'wamid.abc123',
                    from: '5511999999999',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Hello there!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe('text');
    expect(result.messages[0].text?.body).toBe('Hello there!');
    expect(result.messages[0].contactName).toBe('Alice');
    expect(result.messages[0].phoneNumberId).toBe('123456');
    expect(result.messages[0].from).toBe('5511999999999');
    expect(result.messages[0].id).toBe('wamid.abc123');
  });

  it('normalizes an image message', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                contacts: [],
                messages: [
                  {
                    id: 'wamid.img001',
                    from: '5511999999999',
                    timestamp: '1700000001',
                    type: 'image',
                    image: { id: 'media_id_123', mime_type: 'image/jpeg', caption: 'Look!' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe('image');
    expect(result.messages[0].image?.id).toBe('media_id_123');
  });

  it('normalizes an interactive button reply', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                contacts: [],
                messages: [
                  {
                    id: 'wamid.btn001',
                    from: '5511999999999',
                    timestamp: '1700000002',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'btn_yes', title: 'Yes' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe('interactive');
    expect(result.messages[0].interactive?.button_reply?.id).toBe('btn_yes');
    expect(result.messages[0].interactive?.button_reply?.title).toBe('Yes');
  });

  it('normalizes an interactive list reply', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                contacts: [],
                messages: [
                  {
                    id: 'wamid.list001',
                    from: '5511999999999',
                    timestamp: '1700000003',
                    type: 'interactive',
                    interactive: {
                      type: 'list_reply',
                      list_reply: { id: 'row_1', title: 'Option A', description: 'First option' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].interactive?.list_reply?.id).toBe('row_1');
  });

  it('normalizes an inbound order message', () => {
    // Built from the Meta docs order-webhook example.
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
                contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: '16505551234' }],
                messages: [
                  {
                    from: '16505551234',
                    id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=',
                    timestamp: '1750096325',
                    type: 'order',
                    order: {
                      catalog_id: '194836987003835',
                      text: 'Love these!',
                      product_items: [
                        { product_retailer_id: 'di9ozbzfi4', quantity: 2, item_price: 30, currency: 'USD' },
                        { product_retailer_id: 'nqryix03ez', quantity: 1, item_price: 25, currency: 'USD' },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe('order');
    expect(result.messages[0].contactName).toBe('Sheena Nelson');
    expect(result.messages[0].order?.catalog_id).toBe('194836987003835');
    expect(result.messages[0].order?.text).toBe('Love these!');
    expect(result.messages[0].order?.product_items).toHaveLength(2);
    expect(result.messages[0].order?.product_items[0]).toEqual({
      product_retailer_id: 'di9ozbzfi4',
      quantity: 2,
      item_price: 30,
      currency: 'USD',
    });
  });

  it('normalizes an address message response (nfm_reply)', () => {
    // Built from the Meta docs address-message reply example.
    const responseJson =
      '{"saved_address_id":"address1","values":{"in_pin_code":"400063","city":"Mumbai","name":"CUSTOMER_NAME","phone_number":"+91xxxxxxxxxx"}}';
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                contacts: [],
                messages: [
                  {
                    context: { from: 'FROM_PHONE_NUMBER_ID', id: 'wamid.request001' },
                    from: '919999999999',
                    id: 'wamid.addr001',
                    timestamp: '1671498855',
                    type: 'interactive',
                    interactive: {
                      type: 'nfm_reply',
                      nfm_reply: {
                        response_json: responseJson,
                        body: 'CUSTOMER_NAME\n +91xxxxxxxxxx\n 400063, Mumbai',
                        name: 'address_message',
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe('interactive');
    expect(result.messages[0].interactive?.type).toBe('nfm_reply');
    expect(result.messages[0].interactive?.nfm_reply?.name).toBe('address_message');
    expect(result.messages[0].interactive?.nfm_reply?.response_json).toBe(responseJson);
    expect(result.messages[0].interactive?.nfm_reply?.body).toContain('Mumbai');
  });

  it('splits reaction messages into reactions[]', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                contacts: [],
                messages: [
                  {
                    id: 'wamid.react001',
                    from: '5511999999999',
                    timestamp: '1700000004',
                    type: 'reaction',
                    reaction: { message_id: 'wamid.original', emoji: '\u{1f44d}' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(0);
    expect(result.reactions).toHaveLength(1);
    expect(result.reactions[0].messageId).toBe('wamid.original');
    expect(result.reactions[0].emoji).toBe('\u{1f44d}');
    expect(result.reactions[0].from).toBe('5511999999999');
  });

  it('normalizes a delivered status', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                statuses: [
                  {
                    id: 'wamid.sent001',
                    recipient_id: '5511999999999',
                    status: 'delivered',
                    timestamp: '1700000005',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0].status).toBe('delivered');
    expect(result.statuses[0].recipientId).toBe('5511999999999');
  });

  it('normalizes a read status', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                statuses: [
                  {
                    id: 'wamid.sent002',
                    recipient_id: '5511999999999',
                    status: 'read',
                    timestamp: '1700000006',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0].status).toBe('read');
  });

  it('normalizes a failed status with errors', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                statuses: [
                  {
                    id: 'wamid.sent003',
                    recipient_id: '5511999999999',
                    status: 'failed',
                    timestamp: '1700000007',
                    errors: [{ code: 131047, title: 'Re-engagement message', message: '24h window expired' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0].status).toBe('failed');
    expect(result.statuses[0].errors).toHaveLength(1);
    expect(result.statuses[0].errors![0].code).toBe(131047);
  });

  it('extracts multiple messages from one webhook', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                contacts: [],
                messages: [
                  { id: 'msg1', from: '111', timestamp: '1', type: 'text', text: { body: 'First' } },
                  { id: 'msg2', from: '222', timestamp: '2', type: 'text', text: { body: 'Second' } },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].text?.body).toBe('First');
    expect(result.messages[1].text?.body).toBe('Second');
  });

  it('looks up contact name from contacts array', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                contacts: [{ profile: { name: 'Bob Builder' }, wa_id: '4499' }],
                messages: [
                  { id: 'msg1', from: '4499', timestamp: '1', type: 'text', text: { body: 'Hi' } },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages[0].contactName).toBe('Bob Builder');
  });
});

// ---------------------------------------------------------------------------
// Messenger webhook payloads
// ---------------------------------------------------------------------------

describe('normalizeWebhook — Messenger', () => {
  it('normalizes a text message', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID_123',
          messaging: [
            {
              sender: { id: 'USER_1' },
              recipient: { id: 'PAGE_ID_123' },
              timestamp: 1700000000000,
              message: { mid: 'm_abc', text: 'Hello Messenger!' },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe('text');
    expect(result.messages[0].text?.body).toBe('Hello Messenger!');
    expect(result.messages[0].from).toBe('USER_1');
    expect(result.messages[0].phoneNumberId).toBe('PAGE_ID_123');
  });

  it('normalizes a postback', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID_123',
          messaging: [
            {
              sender: { id: 'USER_1' },
              recipient: { id: 'PAGE_ID_123' },
              timestamp: 1700000001000,
              postback: { title: 'Get Started', payload: 'GET_STARTED', mid: 'pb_mid' },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].type).toBe('postback');
    expect(result.messages[0].button?.text).toBe('Get Started');
    expect(result.messages[0].button?.payload).toBe('GET_STARTED');
  });

  it('normalizes a reaction', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID_123',
          messaging: [
            {
              sender: { id: 'USER_1' },
              recipient: { id: 'PAGE_ID_123' },
              timestamp: 1700000002000,
              reaction: { mid: 'm_original', emoji: '\u{2764}\u{fe0f}', action: 'react' },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(0);
    expect(result.reactions).toHaveLength(1);
    expect(result.reactions[0].messageId).toBe('m_original');
    expect(result.reactions[0].emoji).toBe('\u{2764}\u{fe0f}');
  });

  it('normalizes a delivery receipt', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID_123',
          messaging: [
            {
              sender: { id: 'USER_1' },
              recipient: { id: 'PAGE_ID_123' },
              timestamp: 1700000003000,
              delivery: { mids: ['m_sent1', 'm_sent2'], watermark: 1700000003000 },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.statuses).toHaveLength(2);
    expect(result.statuses[0].status).toBe('delivered');
    expect(result.statuses[0].id).toBe('m_sent1');
    expect(result.statuses[1].id).toBe('m_sent2');
  });

  it('normalizes a read receipt', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID_123',
          messaging: [
            {
              sender: { id: 'USER_1' },
              recipient: { id: 'PAGE_ID_123' },
              timestamp: 1700000004000,
              read: { watermark: 1700000004000 },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0].status).toBe('read');
  });

  it('skips echo messages (is_echo: true)', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID_123',
          messaging: [
            {
              sender: { id: 'PAGE_ID_123' },
              recipient: { id: 'USER_1' },
              timestamp: 1700000005000,
              message: { mid: 'm_echo', text: 'Bot response', is_echo: true },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('normalizeWebhook — edge cases', () => {
  it('returns empty arrays for empty payload', () => {
    const result = normalizeWebhook({});
    expect(result.messages).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
    expect(result.reactions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns empty arrays for null/undefined', () => {
    expect(normalizeWebhook(null).messages).toHaveLength(0);
    expect(normalizeWebhook(undefined).messages).toHaveLength(0);
  });

  it('returns empty arrays for unknown object type', () => {
    const result = normalizeWebhook({ object: 'unknown_platform', entry: [] });
    expect(result.messages).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
    expect(result.reactions).toHaveLength(0);
  });

  it('handles empty entry array', () => {
    const result = normalizeWebhook({ object: 'whatsapp_business_account', entry: [] });
    expect(result.messages).toHaveLength(0);
  });

  it('handles missing value.messages gracefully', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456' },
                // no messages or statuses
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages).toHaveLength(0);
    expect(result.statuses).toHaveLength(0);
  });

  it('does not throw on missing fields', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {} }] }],
    };

    expect(() => normalizeWebhook(payload)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// WhatsApp reply / product-inquiry context (real wire shape: { from, id })
// ---------------------------------------------------------------------------

describe('normalizeWebhook — WhatsApp context', () => {
  function waPayload(message: Record<string, unknown>) {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456', display_phone_number: '+1234567890' },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '5511999999999' }],
                messages: [message],
              },
            },
          ],
        },
      ],
    };
  }

  it('maps raw reply context { from, id } to normalized { message_id, from }', () => {
    const result = normalizeWebhook(
      waPayload({
        id: 'wamid.reply1',
        from: '5511999999999',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'replying to your quote' },
        // Real webhook shape per Meta docs — NOT { message_id }.
        context: { from: '15550001111', id: 'wamid.original99', forwarded: true },
      }),
    );

    expect(result.messages[0]?.context).toEqual({
      message_id: 'wamid.original99',
      from: '15550001111',
      forwarded: true,
      frequently_forwarded: undefined,
      referred_product: undefined,
    });
  });

  it('maps a product-inquiry context with referred_product', () => {
    const result = normalizeWebhook(
      waPayload({
        id: 'wamid.inq1',
        from: '5511999999999',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'Is this cake gluten free?' },
        context: {
          from: '15550001111',
          id: 'wamid.productmsg1',
          referred_product: {
            catalog_id: '194836987003835',
            product_retailer_id: 'retail-cake-choc',
          },
        },
      }),
    );

    const context = result.messages[0]?.context;
    expect(context?.message_id).toBe('wamid.productmsg1');
    expect(context?.referred_product).toEqual({
      catalog_id: '194836987003835',
      product_retailer_id: 'retail-cake-choc',
    });
  });
});

describe('normalizeWebhook — WhatsApp status played', () => {
  it('preserves played status without coercing to sent', () => {
    const result = normalizeWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123456' },
                statuses: [
                  {
                    id: 'wamid.voice1',
                    recipient_id: '5511999999999',
                    status: 'played',
                    timestamp: '1700000010',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(result.statuses[0]?.status).toBe('played');
  });
});
