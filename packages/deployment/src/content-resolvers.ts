import type { ArtifactContentResolver } from './binder.js';
import { DeploymentError } from './errors.js';

function assertContentRef(ref: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(ref);
  if (!match) throw new DeploymentError('CONTENT_INVALID', `unsupported artifact content reference ${ref}`);
  return match[1]!;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

/** Resolve the base64 blob map embedded by `kuralle build --host`. */
export function embeddedArtifactContentResolver(
  blobs: Readonly<Record<string, string>>,
): ArtifactContentResolver {
  return {
    async read(ref) {
      assertContentRef(ref);
      const encoded = blobs[ref];
      if (encoded === undefined) throw new DeploymentError('NOT_FOUND', `artifact blob ${ref} is not embedded`);
      return decodeBase64(encoded);
    },
  };
}

export { assertContentRef };
