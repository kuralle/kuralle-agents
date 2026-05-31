/**
 * Run the shared {@link runBaseMetaClientContract} against MessengerClient.
 *
 * Proves the Messenger migration honors the template-method contract
 * (REQ-31 groundwork for C-13.11).
 */
import { createMessengerClient } from '../src/messenger/client.ts';
import { runBaseMetaClientContract } from './base-client-contract.ts';

const APP_SECRET = 'contract-messenger-secret';
const VERIFY_TOKEN = 'contract-messenger-verify';

/** Messenger webhook payload with a single inbound text message. */
const messengerPayload = {
  object: 'page',
  entry: [
    {
      id: 'PAGE_ID',
      messaging: [
        {
          sender: { id: 'USER_1' },
          recipient: { id: 'PAGE_ID' },
          timestamp: 1700000000000,
          message: { mid: 'messenger-contract-1', text: 'contract hello' },
        },
      ],
    },
  ],
};

runBaseMetaClientContract(
  'messenger',
  (overrides) =>
    createMessengerClient({
      pageAccessToken: 'contract-token',
      appSecret: APP_SECRET,
      pageId: 'PAGE_ID',
      verifyToken: VERIFY_TOKEN,
      onHandlerError: overrides?.onHandlerError,
    } as Parameters<typeof createMessengerClient>[0]),
  {
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
    inboundMessagePayload: messengerPayload,
    expectedMessageId: 'messenger-contract-1',
  },
);
