import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VoiceServerMessageSchema,
  VoiceClientMessageSchema,
} from "../../dist/zod.js";

/**
 * Fixture frames matching what @cloudflare/voice's server emits.
 * If the protocol's `welcome` frame ever ceases to parse against our
 * discriminated union, downstream consumers (useVoiceAgent, cf-agent/voice)
 * break in the field. This test is the early-warning alarm.
 */
describe("VoiceServerMessageSchema — welcome fixture", () => {
  it("parses a welcome frame emitted by @cloudflare/voice's server", () => {
    const frame = { type: "welcome", protocol_version: 1 };
    const result = VoiceServerMessageSchema.safeParse(frame);
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.type, "welcome");
      assert.equal(result.data.protocol_version, 1);
    }
  });
});

describe("VoiceClientMessageSchema — hello fixture", () => {
  it("parses the initial client hello frame", () => {
    const frame = { type: "hello", protocol_version: 1 };
    const result = VoiceClientMessageSchema.safeParse(frame);
    assert.equal(result.success, true);
  });
});
