/**
 * Resolver-agnostic shim over `alawmulaw/lib/alaw.js`.
 * Symmetric to `./mulaw.ts` — see that file for the rationale.
 */
import * as alawSubmodule from 'alawmulaw/lib/alaw.js';
import * as alawmulawRoot from 'alawmulaw';

type AlawModule = {
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

function isAlawModule(value: unknown): value is AlawModule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.encode === 'function' && typeof record.decode === 'function';
}

function resolveAlawImpl(): AlawModule {
  const rootDefault = readDefaultExport(alawmulawRoot);
  const candidates: unknown[] = [
    alawSubmodule,
    readDefaultExport(alawSubmodule),
    readNamedExport(alawmulawRoot, 'alaw'),
    rootDefault ? readNamedExport(rootDefault, 'alaw') : undefined,
  ];

  for (const c of candidates) {
    if (isAlawModule(c)) {
      return c;
    }
  }

  throw new Error(
    "@kuralle-agents/transport-base: failed to resolve `alawmulaw` A-law" +
      ' encode/decode under the active module resolver.' +
      ' Installed alawmulaw shape did not match any known layout' +
      ' (named ESM exports, CJS .default wrapper, or root .alaw).' +
      ' If you just upgraded alawmulaw, update this shim.',
  );
}

const impl = resolveAlawImpl();

export function encode(pcm: Int16Array): Uint8Array {
  return impl.encode(pcm);
}

export function decode(bytes: Uint8Array): Int16Array {
  return impl.decode(bytes);
}
