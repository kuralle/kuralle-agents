#!/usr/bin/env npx tsx
/**
 * @deprecated Tool-schema flow diagnostic via KuralleGeminiRealtimeModel.
 *
 * Pre-dates the schema migration to @kuralle-agents/voice-protocol/schema.
 * Schema-conversion contracts are now pinned by unit tests in voice-protocol
 * (toolSetToJsonSchema, toLiveKitToolParameters).
 *
 * For tool-call round-trip end-to-end coverage, use the canonical realtime
 * authority paths:
 *   agentsession-realtime-authority-{gemini,openai,xai}-e2e.ts
 */
console.warn(
  '\ntool-schema-diagnostic.ts retired — schema contracts pinned by voice-protocol unit tests; ' +
  'use agentsession-realtime-authority-gemini-e2e.ts for end-to-end tool round-trip.\n',
);
process.exit(0);
