import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { PiDriverConfig } from './types.js';

export function resolvePiStreamFn(config: PiDriverConfig): StreamFn {
  if (config.streamFn) return config.streamFn;
  if (config.models) {
    return (model, context, options) => config.models!.streamSimple(model, context, options);
  }
  throw new Error(
    'PiDriver requires either `models` (a current @earendil-works/pi-ai Models collection) or `streamFn`.',
  );
}
