import type { ArtifactContentResolver } from './binder.js';
import { assertContentRef } from './content-resolvers.js';
import { DeploymentError } from './errors.js';

export interface ArtifactR2Bucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export function r2ArtifactContentResolver(
  bucket: ArtifactR2Bucket,
  options?: { prefix?: string },
): ArtifactContentResolver {
  const prefix = options?.prefix ?? 'artifacts/';
  return {
    async read(ref) {
      const digest = assertContentRef(ref);
      const object = await bucket.get(`${prefix}${digest}`);
      if (!object) throw new DeploymentError('NOT_FOUND', `artifact blob ${ref} does not exist`);
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}
