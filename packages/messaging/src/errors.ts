/**
 * Base error class for all messaging SDK errors.
 * Carries a machine-readable `code` and the `platform` where the error originated.
 */
export class MessagingError extends Error {
  /** Machine-readable error code (e.g. "RATE_LIMIT", "AUTH_FAILED"). */
  public readonly code: string;

  /** The platform where this error originated (e.g. "whatsapp", "messenger"). */
  public readonly platform: string;

  constructor(message: string, code: string, platform: string) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    this.platform = platform;
  }
}

/**
 * Thrown when the platform's rate limit has been exceeded.
 * Includes the recommended wait time before retrying.
 */
export class RateLimitError extends MessagingError {
  /** Number of milliseconds to wait before retrying. */
  public readonly retryAfterMs: number;

  constructor(message: string, platform: string, retryAfterMs: number) {
    super(message, 'RATE_LIMIT', platform);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown when attempting to send a message outside the allowed messaging window
 * (e.g. WhatsApp's 24-hour customer service window).
 */
export class WindowClosedError extends MessagingError {
  /** When the messaging window expired. */
  public readonly expiredAt: Date;

  /** Template message IDs that can still be sent outside the window. */
  public readonly suggestedTemplates?: string[];

  constructor(message: string, platform: string, expiredAt: Date, suggestedTemplates?: string[]) {
    super(message, 'WINDOW_CLOSED', platform);
    this.name = 'WindowClosedError';
    this.expiredAt = expiredAt;
    this.suggestedTemplates = suggestedTemplates;
  }
}

/**
 * Thrown when API authentication fails (invalid token, expired credentials).
 */
export class AuthenticationError extends MessagingError {
  constructor(message: string, platform: string) {
    super(message, 'AUTH_FAILED', platform);
    this.name = 'AuthenticationError';
  }
}

/**
 * Thrown when the API token lacks required permissions for the operation.
 */
export class PermissionError extends MessagingError {
  constructor(message: string, platform: string) {
    super(message, 'PERMISSION_DENIED', platform);
    this.name = 'PermissionError';
  }
}

/**
 * Thrown when the recipient is invalid, blocked, or unreachable.
 */
export class RecipientError extends MessagingError {
  constructor(message: string, platform: string) {
    super(message, 'RECIPIENT_ERROR', platform);
    this.name = 'RecipientError';
  }
}

/**
 * Thrown when a template message is invalid or not approved.
 */
export class TemplateError extends MessagingError {
  constructor(message: string, platform: string) {
    super(message, 'TEMPLATE_ERROR', platform);
    this.name = 'TemplateError';
  }
}

/**
 * Thrown when a media operation fails (upload, download, invalid format).
 */
export class MediaError extends MessagingError {
  constructor(message: string, platform: string) {
    super(message, 'MEDIA_ERROR', platform);
    this.name = 'MediaError';
  }
}

/**
 * Thrown when webhook signature verification fails.
 * Indicates a potentially spoofed or tampered webhook request.
 */
export class WebhookVerificationError extends MessagingError {
  constructor(message: string, platform: string) {
    super(message, 'WEBHOOK_VERIFICATION_FAILED', platform);
    this.name = 'WebhookVerificationError';
  }
}
