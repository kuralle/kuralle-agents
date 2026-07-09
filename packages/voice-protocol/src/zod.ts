/**
 * Runtime-validatable Zod schemas mirroring each discriminated-union
 * variant exported from `./index.ts`.
 *
 * Importing this subpath pulls in `zod`, which is declared as an
 * optional peer dependency. Consumers that only need the TypeScript
 * types should import from the package root instead.
 */

import { z } from "zod";
import type {
  VoiceClientMessage as _VCM,
  VoiceServerMessage as _VSM,
} from "./index.js";

export const VoiceAudioFormatSchema = z.enum([
  "mp3",
  "pcm16",
  "wav",
  "opus",
  "pcm16-base64",
  "g711-mulaw",
  "g711-alaw",
]);
export const VoiceStatusSchema = z.enum([
  "idle",
  "listening",
  "thinking",
  "speaking",
]);
export const VoiceRoleSchema = z.enum(["user", "assistant"]);

export const VoicePipelineMetricsSchema = z.object({
  llm_ms: z.number(),
  tts_ms: z.number(),
  first_audio_ms: z.number(),
  total_ms: z.number(),
});

export const TranscriptMessageSchema = z.object({
  role: VoiceRoleSchema,
  text: z.string(),
  timestamp: z.number(),
});

// --- Client → Server ---

export const VoiceClientMessageSchema: z.ZodType<_VCM> = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("hello"),
      protocol_version: z.number().optional(),
    }),
    z.object({
      type: z.literal("start_call"),
      preferred_format: VoiceAudioFormatSchema.optional(),
    }),
    z.object({ type: z.literal("end_call") }),
    z.object({ type: z.literal("start_of_speech") }),
    z.object({ type: z.literal("end_of_speech") }),
    z.object({ type: z.literal("interrupt") }),
    z.object({ type: z.literal("text_message"), text: z.string() }),
  ],
);

// --- Server → Client ---

export const VoiceServerMessageSchema: z.ZodType<_VSM> = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("welcome"),
      protocol_version: z.number(),
    }),
    z.object({ type: z.literal("status"), status: VoiceStatusSchema }),
    z.object({
      type: z.literal("audio_config"),
      format: VoiceAudioFormatSchema,
      sampleRate: z.number().optional(),
    }),
    z.object({
      type: z.literal("transcript"),
      role: VoiceRoleSchema,
      text: z.string(),
    }),
    z.object({
      type: z.literal("transcript_start"),
      role: VoiceRoleSchema,
    }),
    z.object({ type: z.literal("transcript_delta"), text: z.string() }),
    z.object({ type: z.literal("transcript_end"), text: z.string() }),
    z.object({ type: z.literal("transcript_interim"), text: z.string() }),
    z.object({
      type: z.literal("metrics"),
      llm_ms: z.number(),
      tts_ms: z.number(),
      first_audio_ms: z.number(),
      total_ms: z.number(),
    }),
    z.object({ type: z.literal("error"), message: z.string() }),
  ],
);
