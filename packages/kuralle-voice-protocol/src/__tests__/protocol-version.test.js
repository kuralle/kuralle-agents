import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VOICE_PROTOCOL_VERSION } from "../../dist/index.js";

describe("VOICE_PROTOCOL_VERSION", () => {
  it("is the constant 1", () => {
    assert.equal(VOICE_PROTOCOL_VERSION, 1);
  });
});
