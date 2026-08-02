import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  createArtifact,
  validateArtifact,
} from '../src/index.js';
import { artifactInput } from './fixtures.js';

describe('canonical agent artifacts', () => {
  it('produces the same digest for equivalent object key insertion orders', async () => {
    const first = artifactInput();
    const second = artifactInput({
      agent: {
        limits: { maxSteps: 20, maxTurns: 12 },
        handoffs: [],
        model: 'openai/gpt-5-mini',
        name: 'Support',
        id: 'support',
      },
    });

    const [a, b] = await Promise.all([createArtifact(first), createArtifact(second)]);

    expect(a.digest).toBe(b.digest);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('rejects unknown fields instead of silently ignoring them', async () => {
    const value = {
      ...artifactInput(),
      digest: '0'.repeat(64),
      runtimeSecret: 'must-never-be-packaged',
    };

    await expect(validateArtifact(value)).rejects.toMatchObject({
      code: 'ARTIFACT_INVALID',
      path: 'artifact.runtimeSecret',
    });
  });

  it('rejects secret values and non-HTTPS tool endpoints through the strict schema', async () => {
    const withSecretValue = {
      ...artifactInput(),
      secretRefs: [{ alias: 'billing-api', purpose: 'Billing API', value: 'secret' }],
    };
    const withUnsafeHttp = artifactInput({
      tools: [{ kind: 'http', id: 'billing', method: 'POST', url: 'http://internal/bill' }],
    });

    await expect(createArtifact(withSecretValue)).rejects.toMatchObject({
      code: 'ARTIFACT_INVALID',
      path: 'artifact.secretRefs[0].value',
    });
    await expect(createArtifact(withUnsafeHttp)).rejects.toMatchObject({
      code: 'ARTIFACT_INVALID',
      path: 'artifact.tools[0].url',
    });
  });

  it('creates an artifact from input with no digest key, still rejecting unknown fields', async () => {
    const created = await createArtifact(artifactInput());
    expect(created.digest).toMatch(/^[a-f0-9]{64}$/);

    const withUnknownField = { ...artifactInput(), runtimeSecret: 'must-never-be-packaged' };
    await expect(createArtifact(withUnknownField as never)).rejects.toMatchObject({
      code: 'ARTIFACT_INVALID',
      path: 'artifact.runtimeSecret',
    });
  });

  it('rejects a published artifact with a missing or malformed digest', async () => {
    const { digest: _digest, ...withoutDigest } = await createArtifact(artifactInput());
    await expect(validateArtifact(withoutDigest)).rejects.toMatchObject({
      code: 'ARTIFACT_INVALID',
      path: 'artifact.digest',
    });

    const withMalformedDigest = { ...(await createArtifact(artifactInput())), digest: 'not-a-sha256' };
    await expect(validateArtifact(withMalformedDigest)).rejects.toMatchObject({
      code: 'ARTIFACT_INVALID',
      path: 'artifact.digest',
    });
  });

  it('detects mutation after publication by recomputing the digest', async () => {
    const published = await createArtifact(artifactInput());
    const altered = structuredClone(published);
    altered.agent.name = 'Altered';

    await expect(validateArtifact(altered)).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH',
      path: 'artifact.digest',
    });
  });
});
