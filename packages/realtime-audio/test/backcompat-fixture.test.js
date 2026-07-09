import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIRealtimeClient } from '../dist/openai/OpenAIRealtimeClient.js';

/**
 * Consumers that do not inspect `.capabilities` must compile and
 * run unchanged against v2. This fixture deliberately treats the client through
 * the pre-v2 surface only (on/off, connected, constructor) and never reads the
 * new readonly accessors. If a future change flips a pre-v2 member's shape,
 * this test catches it.
 *
 * Type-level backwards compatibility is already enforced by the repo-wide
 * `bun run build:packages` pass (every existing dependent typechecks against
 * the new interface). This file is the runtime complement.
 */

/**
 * @param {import('../dist/openai/OpenAIRealtimeClient.js').OpenAIRealtimeClient} client
 */
function exerciseLegacyConsumerSurface(client) {
  const audioHandler = () => {};
  const errorHandler = () => {};
  client.on('audio', audioHandler);
  client.on('error', errorHandler);
  client.off('audio', audioHandler);
  client.off('error', errorHandler);
  return client.connected;
}

describe('RealtimeAudioClient v2 backwards-compat fixture', () => {
  it('pre-v2 consumer pattern works unchanged', () => {
    const client = new OpenAIRealtimeClient({ apiKey: 'test-key' });
    const connected = exerciseLegacyConsumerSurface(client);
    assert.equal(connected, false);
  });
});
