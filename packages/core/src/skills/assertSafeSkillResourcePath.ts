/**
 * Reject hostile or malformed skill resource paths before normalization.
 * A miss on a well-formed relative path is handled by the store (not found + listing).
 */
export function assertSafeSkillResourcePath(path: string): string {
  const trimmed = path.trim();

  if (trimmed.startsWith('/')) {
    throw new Error(`[skills] Invalid resource path "${path}".`);
  }

  if (trimmed.includes('\\')) {
    throw new Error(`[skills] Invalid resource path "${path}".`);
  }

  if (/^[a-zA-Z]:/.test(trimmed)) {
    throw new Error(`[skills] Invalid resource path "${path}".`);
  }

  if (/%2e/i.test(trimmed)) {
    throw new Error(`[skills] Invalid resource path "${path}".`);
  }

  const normalized = trimmed.replace(/^\.?\//, '');

  if (normalized.includes('..')) {
    throw new Error(`[skills] Invalid resource path "${path}".`);
  }

  return normalized;
}
