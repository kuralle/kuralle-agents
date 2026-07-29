import { PiDriver } from '../../src/index.js';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

const model = {
  id: 'bundle-smoke',
  name: 'Bundle smoke',
  api: 'test',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
} satisfies Model<Api>;

const streamFn = (() => {
  throw new Error('bundle-only fixture');
}) as StreamFn;

const driver = new PiDriver({ model, streamFn });

export default {
  fetch() {
    return Response.json({ driver: driver.constructor.name });
  },
};
