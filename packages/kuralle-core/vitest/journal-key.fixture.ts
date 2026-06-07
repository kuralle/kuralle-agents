import { toolEffectKey } from '../src/runtime/durable/idempotency.js';

export const NODE_JOURNAL_KEY = toolEffectKey('run-test', '0', 'ping', { msg: 'hi' });
