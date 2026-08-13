import type { FlowDefinition } from './types.js';
import { canonicalJson, sha256 } from './canonical.js';

export async function flowDigest(def: FlowDefinition): Promise<string> {
  return sha256(canonicalJson(def));
}
