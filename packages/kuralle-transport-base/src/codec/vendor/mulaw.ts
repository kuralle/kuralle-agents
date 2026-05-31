/**
 * Resolver-agnostic shim over `alawmulaw/lib/mulaw.js`.
 *
 * `alawmulaw@6.0.0` ships `main` → CJS UMD, `module` → ESM, and no
 * `"type": "module"` field. Depending on which ESM/CJS resolver loads
 * the submodule path (Bun vs Node vs `tsx`), `import * as mulaw`
 * resolves to either:
 *
 *   - a namespace with named exports `{ encode, decode, ... }` (Bun),
 *   - a namespace whose only key is `default`, holding the functions
 *     on a CJS wrapper (`tsx` / Node ESM loader).
 *
 * This shim normalizes both shapes — plus a final fallback to the
 * package root — into a single stable `{ encode, decode }`. Everything
 * in `@kuralle-agents/transport-base` must import mu-law from here,
 * never from `alawmulaw/lib/mulaw.js` directly.
 *
 * Failure to resolve at module init throws a descriptive error so the
 * breakage surfaces at import time, not at the first frame through the
 * RTP send path (where the original bug was a cryptic runtime crash —
 * see issue #16).
 */
import * as mulawSubmodule from 'alawmulaw/lib/mulaw.js';
import * as alawmulawRoot from 'alawmulaw';

type MulawModule = {
  encode(pcm: Int16Array): Uint8Array;
  decode(bytes: Uint8Array): Int16Array;
};

function readDefaultExport(moduleNs: unknown): unknown {
  if (typeof moduleNs !== 'object' || moduleNs === null || !('default' in moduleNs)) {
    return undefined;
  }
  return (moduleNs as { default: unknown }).default;
}

function readNamedExport(moduleNs: unknown, name: string): unknown {
  if (typeof moduleNs !== 'object' || moduleNs === null || !(name in moduleNs)) {
    return undefined;
  }
  return (moduleNs as Record<string, unknown>)[name];
}

function isMulawModule(value: unknown): value is MulawModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.encode === 'function' && typeof record.decode === 'function';
}

function resolveMulawImpl(): MulawModule {
  const rootDefault = readDefaultExport(alawmulawRoot);
  const candidates: unknown[] = [
    // Bun / Node with resolver that surfaces named exports.
    mulawSubmodule,
    // Node / tsx: CJS-wrapped module lives on `.default`.
    readDefaultExport(mulawSubmodule),
    // Package root (UMD bundle) — last-ditch fallback.
    readNamedExport(alawmulawRoot, 'mulaw'),
    rootDefault ? readNamedExport(rootDefault, 'mulaw') : undefined,
  ];

  for (const c of candidates) {
    if (isMulawModule(c)) {
      return c;
    }
  }

  throw new Error(
    "@kuralle-agents/transport-base: failed to resolve `alawmulaw` mu-law" +
      ' encode/decode under the active module resolver.' +
      ' Installed alawmulaw shape did not match any known layout' +
      ' (named ESM exports, CJS .default wrapper, or root .mulaw).' +
      ' If you just upgraded alawmulaw, update this shim.',
  );
}

const impl = resolveMulawImpl();

export function encode(pcm: Int16Array): Uint8Array {
  return impl.encode(pcm);
}

export function decode(bytes: Uint8Array): Int16Array {
  return impl.decode(bytes);
}
