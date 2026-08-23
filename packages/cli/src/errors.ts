/** Raised when a turn cannot run because credentials are missing or invalid. */
export class AuthRequiredError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AuthRequiredError';
    this.code = code;
  }
}

/** Raised when argv or flags are unusable. Mapped to exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
