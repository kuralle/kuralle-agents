import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OpenAIFamilyMessageQueue,
  DEFAULT_QUEUE_MAX_EVENTS,
  DEFAULT_QUEUE_MAX_BYTES,
} from '../dist/cloudflare/openai-family/message-queue.js';

describe('OpenAIFamilyMessageQueue', () => {
  it('starts empty', () => {
    const q = new OpenAIFamilyMessageQueue();
    assert.equal(q.size, 0);
    assert.equal(q.bytes, 0);
  });

  it('push appends and tracks byte count', () => {
    const q = new OpenAIFamilyMessageQueue();
    q.push('abc');
    q.push('de');
    assert.equal(q.size, 2);
    assert.equal(q.bytes, 5);
  });

  it('drain returns FIFO and resets the queue', () => {
    const q = new OpenAIFamilyMessageQueue();
    q.push('a');
    q.push('b');
    q.push('c');
    const out = q.drain();
    assert.deepEqual(out, ['a', 'b', 'c']);
    assert.equal(q.size, 0);
    assert.equal(q.bytes, 0);
  });

  it('drops oldest items when maxEvents is exceeded', () => {
    const q = new OpenAIFamilyMessageQueue({ maxEvents: 2, maxBytes: 1_000_000 });
    q.push('a');
    q.push('b');
    q.push('c');
    assert.deepEqual(q.drain(), ['b', 'c']);
  });

  it('drops oldest items when maxBytes is exceeded', () => {
    const q = new OpenAIFamilyMessageQueue({ maxEvents: 100, maxBytes: 5 });
    q.push('aa');   // bytes=2
    q.push('bb');   // bytes=4
    q.push('cccc'); // would push to 8, drop until fits
    const out = q.drain();
    // 'aa' + 'bb' was 4; pushing 'cccc' (4) needs to drop until <=5-4=1.
    // After dropping 'aa' bytes=2; still > 1 → drop 'bb' bytes=0; then push.
    assert.deepEqual(out, ['cccc']);
  });

  it('clear empties without returning items', () => {
    const q = new OpenAIFamilyMessageQueue();
    q.push('x');
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(q.bytes, 0);
  });

  it('default limits match exported constants', () => {
    assert.equal(DEFAULT_QUEUE_MAX_EVENTS, 256);
    assert.equal(DEFAULT_QUEUE_MAX_BYTES, 1_048_576);
  });
});
