import { describe, it, expect } from 'bun:test';
import {
  MessagingError,
  RateLimitError,
  WindowClosedError,
  AuthenticationError,
  PermissionError,
  RecipientError,
  TemplateError,
  MediaError,
  WebhookVerificationError,
} from '../src/errors.js';

describe('MessagingError', () => {
  it('has correct name, code, and platform fields', () => {
    const err = new MessagingError('something broke', 'GENERIC', 'whatsapp');
    expect(err.name).toBe('MessagingError');
    expect(err.code).toBe('GENERIC');
    expect(err.platform).toBe('whatsapp');
  });

  it('extends Error', () => {
    const err = new MessagingError('msg', 'CODE', 'messenger');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the error message', () => {
    const err = new MessagingError('detailed failure info', 'X', 'telegram');
    expect(err.message).toBe('detailed failure info');
  });
});

describe('RateLimitError', () => {
  it('has correct name, code, and retryAfterMs', () => {
    const err = new RateLimitError('too many requests', 'whatsapp', 5000);
    expect(err.name).toBe('RateLimitError');
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.platform).toBe('whatsapp');
    expect(err.retryAfterMs).toBe(5000);
  });

  it('extends MessagingError and Error', () => {
    const err = new RateLimitError('slow down', 'messenger', 1000);
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the error message', () => {
    const err = new RateLimitError('rate limited', 'whatsapp', 3000);
    expect(err.message).toBe('rate limited');
  });
});

describe('WindowClosedError', () => {
  it('has correct name, code, expiredAt, and optional suggestedTemplates', () => {
    const expiredAt = new Date('2026-01-01T00:00:00Z');
    const err = new WindowClosedError('window closed', 'whatsapp', expiredAt, ['template_1', 'template_2']);
    expect(err.name).toBe('WindowClosedError');
    expect(err.code).toBe('WINDOW_CLOSED');
    expect(err.platform).toBe('whatsapp');
    expect(err.expiredAt).toBe(expiredAt);
    expect(err.suggestedTemplates).toEqual(['template_1', 'template_2']);
  });

  it('allows suggestedTemplates to be undefined', () => {
    const expiredAt = new Date();
    const err = new WindowClosedError('window closed', 'whatsapp', expiredAt);
    expect(err.suggestedTemplates).toBeUndefined();
  });

  it('extends MessagingError and Error', () => {
    const err = new WindowClosedError('closed', 'whatsapp', new Date());
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the error message', () => {
    const err = new WindowClosedError('24h window expired', 'whatsapp', new Date());
    expect(err.message).toBe('24h window expired');
  });
});

describe('AuthenticationError', () => {
  it('has correct name and code', () => {
    const err = new AuthenticationError('invalid token', 'messenger');
    expect(err.name).toBe('AuthenticationError');
    expect(err.code).toBe('AUTH_FAILED');
    expect(err.platform).toBe('messenger');
  });

  it('extends MessagingError and Error', () => {
    const err = new AuthenticationError('bad token', 'whatsapp');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the error message', () => {
    const err = new AuthenticationError('token expired at midnight', 'messenger');
    expect(err.message).toBe('token expired at midnight');
  });
});

describe('PermissionError', () => {
  it('has correct name and code', () => {
    const err = new PermissionError('insufficient permissions', 'telegram');
    expect(err.name).toBe('PermissionError');
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.platform).toBe('telegram');
  });

  it('extends MessagingError and Error', () => {
    const err = new PermissionError('denied', 'slack');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('RecipientError', () => {
  it('has correct name and code', () => {
    const err = new RecipientError('user blocked', 'whatsapp');
    expect(err.name).toBe('RecipientError');
    expect(err.code).toBe('RECIPIENT_ERROR');
    expect(err.platform).toBe('whatsapp');
  });

  it('extends MessagingError and Error', () => {
    const err = new RecipientError('blocked', 'messenger');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('TemplateError', () => {
  it('has correct name and code', () => {
    const err = new TemplateError('template not approved', 'whatsapp');
    expect(err.name).toBe('TemplateError');
    expect(err.code).toBe('TEMPLATE_ERROR');
    expect(err.platform).toBe('whatsapp');
  });

  it('extends MessagingError and Error', () => {
    const err = new TemplateError('bad template', 'whatsapp');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('MediaError', () => {
  it('has correct name and code', () => {
    const err = new MediaError('unsupported format', 'messenger');
    expect(err.name).toBe('MediaError');
    expect(err.code).toBe('MEDIA_ERROR');
    expect(err.platform).toBe('messenger');
  });

  it('extends MessagingError and Error', () => {
    const err = new MediaError('upload failed', 'whatsapp');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('WebhookVerificationError', () => {
  it('has correct name and code', () => {
    const err = new WebhookVerificationError('signature mismatch', 'whatsapp');
    expect(err.name).toBe('WebhookVerificationError');
    expect(err.code).toBe('WEBHOOK_VERIFICATION_FAILED');
    expect(err.platform).toBe('whatsapp');
  });

  it('extends MessagingError and Error', () => {
    const err = new WebhookVerificationError('tampered', 'messenger');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the error message', () => {
    const err = new WebhookVerificationError('HMAC verification failed', 'whatsapp');
    expect(err.message).toBe('HMAC verification failed');
  });
});

describe('instanceof checks across the hierarchy', () => {
  it('all subclasses are instanceof MessagingError', () => {
    const errors = [
      new RateLimitError('x', 'p', 100),
      new WindowClosedError('x', 'p', new Date()),
      new AuthenticationError('x', 'p'),
      new PermissionError('x', 'p'),
      new RecipientError('x', 'p'),
      new TemplateError('x', 'p'),
      new MediaError('x', 'p'),
      new WebhookVerificationError('x', 'p'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(MessagingError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('subclasses are not instanceof each other', () => {
    const rateLimitErr = new RateLimitError('x', 'p', 100);
    const authErr = new AuthenticationError('x', 'p');

    expect(rateLimitErr).not.toBeInstanceOf(AuthenticationError);
    expect(authErr).not.toBeInstanceOf(RateLimitError);
  });
});
