import { describe, it, expect } from 'bun:test';
import {
  classifyMetaError,
  MessagingError,
  RateLimitError,
  AuthenticationError,
  PermissionError,
  RecipientError,
  WindowClosedError,
  TemplateError,
} from '../src/graph-api/errors.ts';

// Also import from @kuralle-agents/messaging to confirm they are the same classes
import {
  MessagingError as BaseMessagingError,
  RateLimitError as BaseRateLimitError,
  AuthenticationError as BaseAuthenticationError,
  PermissionError as BasePermissionError,
  RecipientError as BaseRecipientError,
  WindowClosedError as BaseWindowClosedError,
  TemplateError as BaseTemplateError,
} from '@kuralle-agents/messaging';

const PLATFORM = 'whatsapp';

function metaBody(code?: number, subcode?: number, message?: string) {
  if (code === undefined) return null;
  return {
    error: {
      message: message ?? `Error code ${code}`,
      type: 'OAuthException',
      code,
      error_subcode: subcode,
      fbtrace_id: 'trace_123',
    },
  };
}

describe('classifyMetaError — rate limiting', () => {
  it('HTTP 429 -> RateLimitError', () => {
    const err = classifyMetaError(429, metaBody(undefined), PLATFORM);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(MessagingError);
  });

  it('Meta code 4 -> RateLimitError', () => {
    const err = classifyMetaError(400, metaBody(4), PLATFORM);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('Meta code 32 -> RateLimitError', () => {
    const err = classifyMetaError(400, metaBody(32), PLATFORM);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('Meta code 613 -> RateLimitError', () => {
    const err = classifyMetaError(400, metaBody(613), PLATFORM);
    expect(err).toBeInstanceOf(RateLimitError);
  });
});

describe('classifyMetaError — authentication', () => {
  it('HTTP 401 -> AuthenticationError', () => {
    const err = classifyMetaError(401, metaBody(undefined), PLATFORM);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toBeInstanceOf(MessagingError);
  });

  it('Meta code 190 -> AuthenticationError', () => {
    const err = classifyMetaError(400, metaBody(190), PLATFORM);
    expect(err).toBeInstanceOf(AuthenticationError);
  });
});

describe('classifyMetaError — permissions', () => {
  it('HTTP 403 -> PermissionError', () => {
    const err = classifyMetaError(403, metaBody(undefined), PLATFORM);
    expect(err).toBeInstanceOf(PermissionError);
    expect(err).toBeInstanceOf(MessagingError);
  });

  it('Meta code 10 -> PermissionError', () => {
    const err = classifyMetaError(400, metaBody(10), PLATFORM);
    expect(err).toBeInstanceOf(PermissionError);
  });

  it('Meta code 200 -> PermissionError', () => {
    const err = classifyMetaError(400, metaBody(200), PLATFORM);
    expect(err).toBeInstanceOf(PermissionError);
  });
});

describe('classifyMetaError — window closed', () => {
  it('Meta code 131047 -> WindowClosedError', () => {
    const err = classifyMetaError(400, metaBody(131047), PLATFORM);
    expect(err).toBeInstanceOf(WindowClosedError);
    expect(err).toBeInstanceOf(MessagingError);
  });

  it('Meta code 1545041 -> WindowClosedError (Messenger)', () => {
    const err = classifyMetaError(400, metaBody(1545041), 'messenger');
    expect(err).toBeInstanceOf(WindowClosedError);
  });
});

describe('classifyMetaError — person unavailable', () => {
  it('Meta code 551 -> person_unavailable MessagingError', () => {
    const err = classifyMetaError(400, metaBody(551), 'messenger');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err.code).toBe('person_unavailable');
  });
});

describe('classifyMetaError — recipient', () => {
  it('HTTP 404 -> RecipientError', () => {
    const err = classifyMetaError(404, metaBody(undefined), PLATFORM);
    expect(err).toBeInstanceOf(RecipientError);
    expect(err).toBeInstanceOf(MessagingError);
  });

  it('Meta code 131026 -> RecipientError', () => {
    const err = classifyMetaError(400, metaBody(131026), PLATFORM);
    expect(err).toBeInstanceOf(RecipientError);
  });
});

describe('classifyMetaError — template errors', () => {
  it('Meta code 132001 -> TemplateError', () => {
    const err = classifyMetaError(400, metaBody(132001), PLATFORM);
    expect(err).toBeInstanceOf(TemplateError);
    expect(err).toBeInstanceOf(MessagingError);
  });

  it('Meta code 132999 -> TemplateError', () => {
    const err = classifyMetaError(400, metaBody(132999), PLATFORM);
    expect(err).toBeInstanceOf(TemplateError);
  });

  it('Meta subcode 132500 -> TemplateError', () => {
    const err = classifyMetaError(400, metaBody(999, 132500), PLATFORM);
    expect(err).toBeInstanceOf(TemplateError);
  });
});

describe('classifyMetaError — fallback', () => {
  it('unknown code -> MessagingError with meta_error_{code}', () => {
    const err = classifyMetaError(400, metaBody(99999), PLATFORM);
    expect(err).toBeInstanceOf(MessagingError);
    expect(err.code).toBe('meta_error_99999');
  });

  it('null body -> MessagingError fallback', () => {
    const err = classifyMetaError(500, null, PLATFORM);
    expect(err).toBeInstanceOf(MessagingError);
    expect(err.message).toContain('500');
  });
});

describe('classifyMetaError — class identity matches @kuralle-agents/messaging', () => {
  it('error classes are the SAME as those from @kuralle-agents/messaging', () => {
    expect(MessagingError).toBe(BaseMessagingError);
    expect(RateLimitError).toBe(BaseRateLimitError);
    expect(AuthenticationError).toBe(BaseAuthenticationError);
    expect(PermissionError).toBe(BasePermissionError);
    expect(RecipientError).toBe(BaseRecipientError);
    expect(WindowClosedError).toBe(BaseWindowClosedError);
    expect(TemplateError).toBe(BaseTemplateError);
  });

  it('instanceof checks work across packages', () => {
    const err = classifyMetaError(429, metaBody(4), PLATFORM);
    expect(err).toBeInstanceOf(BaseRateLimitError);
    expect(err).toBeInstanceOf(BaseMessagingError);
  });
});
