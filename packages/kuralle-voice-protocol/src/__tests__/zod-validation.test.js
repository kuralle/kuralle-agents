import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VoiceClientMessageSchema,
  VoiceServerMessageSchema,
} from "../../dist/zod.js";

describe("Zod schemas reject malformed frames", () => {
  it("rejects unknown client message type", () => {
    const result = VoiceClientMessageSchema.safeParse({
      type: "nonexistent",
    });
    assert.equal(result.success, false);
  });

  it("rejects unknown server message type", () => {
    const result = VoiceServerMessageSchema.safeParse({
      type: "nonexistent",
    });
    assert.equal(result.success, false);
  });

  it("rejects text_message without text", () => {
    const result = VoiceClientMessageSchema.safeParse({
      type: "text_message",
    });
    assert.equal(result.success, false);
  });

  it("rejects welcome without protocol_version", () => {
    const result = VoiceServerMessageSchema.safeParse({
      type: "welcome",
    });
    assert.equal(result.success, false);
  });

  it("rejects audio_config with an invalid format", () => {
    const result = VoiceServerMessageSchema.safeParse({
      type: "audio_config",
      format: "flac",
    });
    assert.equal(result.success, false);
  });
});

describe("Zod schemas accept every valid variant", () => {
  const clientVariants = [
    { type: "hello" },
    { type: "hello", protocol_version: 1 },
    { type: "start_call" },
    { type: "start_call", preferred_format: "pcm16" },
    { type: "end_call" },
    { type: "start_of_speech" },
    { type: "end_of_speech" },
    { type: "interrupt" },
    { type: "text_message", text: "hello" },
  ];

  const serverVariants = [
    { type: "welcome", protocol_version: 1 },
    { type: "status", status: "idle" },
    { type: "status", status: "listening" },
    { type: "status", status: "thinking" },
    { type: "status", status: "speaking" },
    { type: "audio_config", format: "mp3" },
    { type: "audio_config", format: "pcm16", sampleRate: 24000 },
    { type: "audio_config", format: "wav" },
    { type: "audio_config", format: "opus" },
    { type: "transcript", role: "user", text: "hi" },
    { type: "transcript", role: "assistant", text: "hello" },
    { type: "transcript_start", role: "assistant" },
    { type: "transcript_delta", text: "hel" },
    { type: "transcript_end", text: "hello" },
    { type: "transcript_interim", text: "hel" },
    {
      type: "metrics",
      llm_ms: 10,
      tts_ms: 20,
      first_audio_ms: 30,
      total_ms: 60,
    },
    { type: "error", message: "oops" },
  ];

  for (const variant of clientVariants) {
    it(`accepts client variant: ${variant.type}${
      variant.preferred_format ? "+preferred_format" : ""
    }${variant.text ? "+text" : ""}${
      variant.protocol_version ? "+protocol_version" : ""
    }`, () => {
      const result = VoiceClientMessageSchema.safeParse(variant);
      assert.equal(result.success, true, JSON.stringify(result.error));
    });
  }

  for (const variant of serverVariants) {
    it(`accepts server variant: ${variant.type}`, () => {
      const result = VoiceServerMessageSchema.safeParse(variant);
      assert.equal(result.success, true, JSON.stringify(result.error));
    });
  }
});
