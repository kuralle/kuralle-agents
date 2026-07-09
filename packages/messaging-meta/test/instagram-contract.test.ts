/**
 * Run the shared {@link runBaseMetaClientContract} against InstagramClient.
 */
import { createInstagramClient } from '../src/instagram/client.ts';
import { runBaseMetaClientContract } from './base-client-contract.ts';

const APP_SECRET = 'contract-instagram-secret';
const VERIFY_TOKEN = 'contract-instagram-verify';

/** Instagram webhook payload — uses the same `page`-object shape as Messenger. */
const instagramPayload = {
  object: 'instagram',
  entry: [
    {
      id: 'IG_ACCOUNT',
      messaging: [
        {
          sender: { id: 'IG_USER_1' },
          recipient: { id: 'IG_ACCOUNT' },
          timestamp: 1700000000000,
          message: { mid: 'instagram-contract-1', text: 'contract hi' },
        },
      ],
    },
  ],
};

runBaseMetaClientContract(
  'instagram',
  (overrides) =>
    createInstagramClient({
      accessToken: 'contract-token',
      appSecret: APP_SECRET,
      igId: 'IG_ACCOUNT',
      verifyToken: VERIFY_TOKEN,
      onHandlerError: overrides?.onHandlerError,
    } as Parameters<typeof createInstagramClient>[0]),
  {
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    inboundMessagePayload: instagramPayload,
    expectedMessageId: 'instagram-contract-1',
  },
);
