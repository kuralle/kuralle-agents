#!/usr/bin/env npx tsx
/**
 * @deprecated Head-to-head 3-path latency benchmark.
 *
 * Path A (RealtimeRuntime native) and Path C (cascaded) remain valid, but
 * Path B specifically benchmarked KuralleGeminiRealtimeModel which has
 * been removed in alpha. The benchmark therefore loses its purpose — Path B
 * canonical (createKuralleRealtimeAgent) goes through identical underlying
 * GeminiLiveSession plumbing as Path A, so an apples-to-apples comparison
 * collapses to two paths.
 *
 * If you need latency numbers, run the canonical paths individually:
 *   npx tsx packages/e2e-tests/tests/agentsession-realtime-authority-gemini-e2e.ts
 *   npx tsx packages/e2e-tests/tests/agentsession-kuralle-direct-e2e.ts
 *
 * The realtime-authority test reports first-text / first-audio / total latency
 * per turn. The cascaded test reports the same plus tool-execution latency.
 */
console.warn(
  '\nhead-to-head-benchmark.ts retired — Path B (KuralleGeminiRealtimeModel) removed.\n' +
  'For latency numbers, run agentsession-realtime-authority-gemini-e2e.ts (realtime)\n' +
  'or agentsession-kuralle-direct-e2e.ts (cascaded) individually.\n',
);
process.exit(0);
