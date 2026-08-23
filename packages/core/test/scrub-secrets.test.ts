import { describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { scrubSecrets, SECRET_MARKER, CIRCULAR_MARKER } from '../src/events/scrubSecrets.ts';

describe('scrubSecrets', () => {
  it('scrubs sk- strings, JWTs, and password-keyed values in tool-call args', () => {
    const input = {
      channel: 'internal' as const,
      type: 'tool-call' as const,
      payload: {
        toolName: 'configure',
        args: {
          apiKey: 'sk-proj-abc123def456',
          note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
          password: 'hunter2',
          label: 'production',
        },
      },
    };

    const output = scrubSecrets(input);

    expect(output.payload.args).toEqual({
      apiKey: SECRET_MARKER,
      note: SECRET_MARKER,
      password: SECRET_MARKER,
      label: 'production',
    });
    expect(Object.keys(output.payload.args as object).sort()).toEqual(
      Object.keys(input.payload.args).sort(),
    );
  });

  it('returns ordinary tool-call args deep-equal to input', () => {
    const input = {
      channel: 'internal' as const,
      type: 'tool-call' as const,
      payload: {
        toolName: 'search',
        args: { query: 'hello world', limit: 10, active: true },
      },
    };

    expect(scrubSecrets(input)).toEqual(input);
  });

  it('returns text-delta unchanged by reference', () => {
    const input = {
      channel: 'client' as const,
      type: 'text-delta' as const,
      payload: { id: 't1', delta: 'hello' },
    };

    expect(scrubSecrets(input)).toBe(input);
  });

  it('scrubs nested secrets while preserving shape', () => {
    const input = {
      channel: 'internal' as const,
      type: 'tool-result' as const,
      payload: {
        toolName: 'fetch',
        result: {
          items: [{ meta: { token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }, ok: true }],
          count: 1,
        },
      },
    };

    const output = scrubSecrets(input);

    expect(output.payload.result).toEqual({
      items: [{ meta: { token: SECRET_MARKER }, ok: true }],
      count: 1,
    });
  });

  it('does not hang on self-referential objects and replaces cycle back-edges', () => {
    const cyclic: Record<string, unknown> = { name: 'loop', status: 'plain' };
    cyclic.self = cyclic;

    const input = {
      channel: 'internal' as const,
      type: 'custom' as const,
      payload: {
        name: 'cycle',
        data: cyclic,
      },
    };

    expect(() => scrubSecrets(input)).not.toThrow();
    const output = scrubSecrets(input);
    expect(output.payload.data).toEqual({
      name: 'loop',
      status: 'plain',
      self: CIRCULAR_MARKER,
    });
  });

  it('scrubs both occurrences when the same object is referenced from two keys', () => {
    const shared = { apiKey: 'sk-proj-abcdef123456' };
    const input = {
      channel: 'internal' as const,
      type: 'tool-call' as const,
      payload: {
        toolName: 'configure',
        args: { first: shared, second: shared },
      },
    };

    const output = scrubSecrets(input);

    expect((output.payload.args as { first: { apiKey: string } }).first.apiKey).toBe(
      SECRET_MARKER,
    );
    expect((output.payload.args as { second: { apiKey: string } }).second.apiKey).toBe(
      SECRET_MARKER,
    );
  });

  it('preserves ordinary identifiers under neutral key names', () => {
    const cases = [
      { orderId: '550e8400-e29b-41d4-a716-446655440000' },
      { path: '/Users/dev/Documents/project/src/index.ts' },
      { sha: 'a13c1005f2b9c4e7d8a1b2c3d4e5f60718293a4b' },
      { url: 'https://api.example.com/v1/orders/4471/shipments' },
    ];

    for (const args of cases) {
      const input = {
        channel: 'internal' as const,
        type: 'tool-call' as const,
        payload: { toolName: 't', args },
      };
      expect(scrubSecrets(input)).toEqual(input);
    }
  });

  it('fix 1: scrubs paused interrupt operation args and responseSchema', () => {
    const input = {
      channel: 'internal' as const,
      type: 'paused' as const,
      payload: {
        waitingFor: 'approval',
        interrupt: {
          requestId: 'req-1',
          kind: 'approval' as const,
          signalName: 'configure',
          operation: {
            toolCallId: 'tc-1',
            toolName: 'configure',
            args: { apiKey: 'sk_live_abc123', label: 'prod' },
            argsHash: 'abc',
          },
          display: { title: 'Approve configure' },
          responseSchema: { token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' },
          deadline: null,
          allowedDecisions: ['approve' as const, 'deny' as const],
          createdAt: 1,
        },
      },
    };

    const output = scrubSecrets(input);

    expect(output.payload.interrupt.operation?.args).toEqual({
      apiKey: SECRET_MARKER,
      label: 'prod',
    });
    expect(output.payload.interrupt.responseSchema).toEqual({ token: SECRET_MARKER });
  });

  it('fix 2: redacts non-string carriers under secret-shaped keys', () => {
    const passwordBuffer = Buffer.from('hunter2');
    const apiKeyMap = new Map([['nested', 'sk-proj-secret']]);
    const input = {
      channel: 'internal' as const,
      type: 'tool-result' as const,
      payload: {
        toolName: 'readKey',
        result: {
          password: passwordBuffer,
          apiKey: apiKeyMap,
          note: new Uint8Array([1, 2, 3]),
        },
      },
    };

    const output = scrubSecrets(input);

    expect((output.payload.result as { password: unknown }).password).toBe(SECRET_MARKER);
    expect((output.payload.result as { apiKey: unknown }).apiKey).toBe(SECRET_MARKER);
    expect((output.payload.result as { note: Uint8Array }).note).toBe(input.payload.result.note);
  });

  it('fix 3: cycle back-edges never embed the original unscrubbed object', () => {
    const cyclic: Record<string, unknown> = { apiKey: 'sk-proj-leaked' };
    cyclic.self = cyclic;

    const input = {
      channel: 'internal' as const,
      type: 'custom' as const,
      payload: { data: cyclic },
    };

    const output = scrubSecrets(input);
    const data = output.payload.data as { apiKey: string; self: unknown };

    expect(data.apiKey).toBe(SECRET_MARKER);
    expect(data.self).toBe(CIRCULAR_MARKER);
    expect(data.self).not.toBe(cyclic);
  });

  it('fix 4: catches self-announcing secrets missed by earlier patterns', () => {
    const input = {
      channel: 'internal' as const,
      type: 'tool-call' as const,
      payload: {
        toolName: 'configure',
        args: {
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
          stripe: 'sk_live_abc123',
          github: 'github_pat_11ABCDEF',
          google: 'ya29.a0AfH6SMBx',
          npm: 'npm_abcdefghijklmnopqrstuvwxyz',
          aws: 'ASIAIOSFODNN7EXAMPLE',
          slack: 'xapp-1-A0123456789',
          header: 'bearer sk-test',
          auth: 'plain-secret-value',
          dsn: 'postgres://admin:hunter2@db.internal:5432/app',
          config: '{"apiKey":"sk-proj-embedded"}',
        },
      },
    };

    const output = scrubSecrets(input);
    const args = output.payload.args as Record<string, string>;

    expect(args.privateKey).toBe(SECRET_MARKER);
    expect(args.stripe).toBe(SECRET_MARKER);
    expect(args.github).toBe(SECRET_MARKER);
    expect(args.google).toBe(SECRET_MARKER);
    expect(args.npm).toBe(SECRET_MARKER);
    expect(args.aws).toBe(SECRET_MARKER);
    expect(args.slack).toBe(SECRET_MARKER);
    expect(args.header).toBe(SECRET_MARKER);
    expect(args.auth).toBe(SECRET_MARKER);
    expect(args.dsn).toBe(SECRET_MARKER);
    expect(args.config).toBe('{"apiKey":"[REDACTED]"}');
  });

  it('fix 5: fails closed past the walk depth cap', () => {
    let nested: Record<string, unknown> = { apiKey: 'sk-proj-buried-deep' };
    for (let depth = 0; depth < 70; depth += 1) {
      nested = { child: nested };
    }

    const input = {
      channel: 'internal' as const,
      type: 'tool-call' as const,
      payload: { toolName: 'deep', args: nested },
    };

    const output = scrubSecrets(input);
    let probe: unknown = output.payload.args;
    for (let depth = 0; depth < 64; depth += 1) {
      probe = (probe as Record<string, unknown>).child;
    }
    expect((probe as Record<string, unknown>).child).toBe(SECRET_MARKER);
  });

  it('fix 6: anchored token key pattern preserves tokenizer and tokenCount', () => {
    const input = {
      channel: 'internal' as const,
      type: 'tool-call' as const,
      payload: {
        toolName: 'analyze',
        args: {
          tokenizer: 'whitespace',
          tokenCount: 'high',
          token: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
        },
      },
    };

    const output = scrubSecrets(input);

    expect(output.payload.args).toEqual({
      tokenizer: 'whitespace',
      tokenCount: 'high',
      token: SECRET_MARKER,
    });
  });
});

describe('credential key names in snake_case and camelCase', () => {
  const value = 'aB3xQ9zL2mN7pR4tY6wE1sD8fG5hJ0kC';
  const argsFor = (key: string): Record<string, unknown> =>
    (scrubSecrets({
      channel: 'internal',
      type: 'tool-call',
      payload: { toolName: 't', args: { [key]: value } },
    } as StreamPart) as Extract<StreamPart, { type: 'tool-call' }>).payload.args as Record<string, unknown>;

  // `\b` cannot anchor these: `_` is a word character in JS regex, so \btoken\b never fires
  // inside access_token — the canonical credential with no value prefix.
  for (const key of [
    'access_token', 'auth_token', 'session_token', 'refresh_token', 'api_token',
    'personal_access_token', 'accessToken', 'authToken', 'sessionToken', 'refreshToken',
  ]) {
    it(`redacts ${key}`, () => {
      expect(argsFor(key)[key]).toBe(SECRET_MARKER);
    });
  }

  for (const key of ['tokenizer', 'tokenCount', 'authorizedUsers', 'patterns', 'accessibility']) {
    it(`keeps ${key}`, () => {
      expect(argsFor(key)[key]).toBe(value);
    });
  }
});

describe('secondary payload carriers', () => {
  it('scrubs a credential-bearing URL out of an error message', () => {
    const part = {
      channel: 'client',
      type: 'error',
      payload: { error: 'fetch failed: https://admin:hunter2@db.internal/x' },
    } as StreamPart;
    expect(JSON.stringify(scrubSecrets(part))).not.toContain('hunter2');
  });

  // The twin of safety-blocked.rationale, which is walked; leaving this one out was inconsistent.
  // Asserts the field is REACHED, using a userinfo URL — a prefix-bearing secret embedded mid-prose
  // is a stated limitation of the heuristic, not something this test should claim.
  it('scrubs a credential-bearing URL out of a pipeline-validation-block rationale', () => {
    const part = {
      channel: 'internal',
      type: 'pipeline-validation-block',
      payload: { rationale: 'rejected: connection https://admin:hunter2@db.internal/x' },
    } as StreamPart;
    expect(JSON.stringify(scrubSecrets(part))).not.toContain('hunter2');
  });
});
