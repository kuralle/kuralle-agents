/**
 * Runtime detection utility for automatic vector store selection.
 *
 * Detects the current JavaScript runtime environment and returns a
 * descriptor that helps callers choose the appropriate vector store
 * implementation without importing all store packages.
 *
 * Detection order:
 * 1. Cloudflare Workers (caches global, no fs)
 * 2. Deno (Deno global)
 * 3. Bun (Bun global)
 * 4. Node.js (process.versions.node)
 * 5. Unknown (fallback)
 */

export type RuntimeEnvironment =
  | 'cloudflare-workers'
  | 'deno'
  | 'bun'
  | 'node'
  | 'unknown';

export interface RuntimeInfo {
  /** Detected runtime environment. */
  runtime: RuntimeEnvironment;
  /** Whether the runtime supports native filesystem access. */
  hasFileSystem: boolean;
  /** Whether the runtime supports native addons / binary modules. */
  hasNativeAddons: boolean;
  /** Recommended store strategy. */
  recommendedStore: 'lancedb' | 'http-vectorize' | 'http-upstash' | 'in-memory';
}

/**
 * Detect the current runtime environment and return recommendations
 * for vector store selection.
 */
export function detectRuntime(): RuntimeInfo {
  // Cloudflare Workers: has `caches` global, no `process.versions.node`
  if (
    typeof globalThis !== 'undefined' &&
    'caches' in globalThis &&
    typeof (globalThis as Record<string, unknown>).caches === 'object' &&
    !(typeof process !== 'undefined' && process.versions?.node)
  ) {
    return {
      runtime: 'cloudflare-workers',
      hasFileSystem: false,
      hasNativeAddons: false,
      recommendedStore: 'http-vectorize',
    };
  }

  // Deno
  if (typeof (globalThis as Record<string, unknown>).Deno !== 'undefined') {
    return {
      runtime: 'deno',
      hasFileSystem: true,
      hasNativeAddons: false,
      recommendedStore: 'http-upstash',
    };
  }

  // Bun
  if (typeof (globalThis as Record<string, unknown>).Bun !== 'undefined') {
    return {
      runtime: 'bun',
      hasFileSystem: true,
      hasNativeAddons: true,
      recommendedStore: 'lancedb',
    };
  }

  // Node.js
  if (typeof process !== 'undefined' && process.versions?.node) {
    return {
      runtime: 'node',
      hasFileSystem: true,
      hasNativeAddons: true,
      recommendedStore: 'lancedb',
    };
  }

  // Unknown (browser, edge function without Workers detection, etc.)
  return {
    runtime: 'unknown',
    hasFileSystem: false,
    hasNativeAddons: false,
    recommendedStore: 'in-memory',
  };
}
