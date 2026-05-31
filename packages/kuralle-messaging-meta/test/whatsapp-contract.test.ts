/**
 * Run the shared {@link runBaseMetaClientContract} against WhatsAppClient.
 */
import { createWhatsAppClient } from '../src/whatsapp/client.ts';
import { runBaseMetaClientContract } from './base-client-contract.ts';

const APP_SECRET = 'contract-whatsapp-secret';
const VERIFY_TOKEN = 'contract-whatsapp-verify';

const whatsappPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '123' },
            contacts: [{ wa_id: '+15551234567', profile: { name: 'Contract User' } }],
            messages: [
              {
                id: 'wamid.CONTRACT001',
                from: '+15551234567',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'contract hi' },
              },
            ],
          },
        },
      ],
    },
  ],
};

runBaseMetaClientContract(
  'whatsapp',
  (overrides) =>
    createWhatsAppClient({
      accessToken: 'contract-token',
      appSecret: APP_SECRET,
      phoneNumberId: '123',
      verifyToken: VERIFY_TOKEN,
      onHandlerError: overrides?.onHandlerError,
    } as Parameters<typeof createWhatsAppClient>[0]),
  {
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    inboundMessagePayload: whatsappPayload,
    expectedMessageId: 'wamid.CONTRACT001',
  },
);
